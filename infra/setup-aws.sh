#!/usr/bin/env bash
# infra/setup-aws.sh — one-shot provisioner for voice-ai.samueleddy.com.
#
# Provisions, in the Bedison AWS account / us-east-1:
#   - Security group: SSH from your current public IP, 80+443 from anywhere.
#   - EC2 t4g.micro (AL2023 ARM), 20GB gp3 root, user-data = infra/bootstrap.sh.
#   - Elastic IP, associated with the instance.
#   - Route 53 A record voice-ai.samueleddy.com -> EIP.
#
# Tags every resource with Project=voice-ai-conversation-relay-elevenlabs.
#
# Idempotent for SG and DNS lookups (re-runs reuse, don't duplicate).
# NOT idempotent for EC2 + EIP — re-running after a successful run will
# create a second instance and a second EIP. If you need to re-run, terminate
# the old instance and release the old EIP first.
#
# Requirements on your laptop: aws CLI v2, jq, curl, an existing EC2 key pair
# in the target region (the script aborts if KEY_NAME doesn't exist).
#
# Usage:
#   KEY_NAME=voice-ai-aws ./infra/setup-aws.sh
#
# Optional overrides (env vars):
#   AWS_PROFILE       (default: bedison)
#   AWS_REGION        (default: us-east-1)
#   DOMAIN            (default: voice-ai.samueleddy.com)
#   ROOT_DOMAIN       (default: samueleddy.com)
#   INSTANCE_TYPE     (default: t4g.micro)
#   ROOT_VOLUME_GB    (default: 20)
#   MY_IP_OVERRIDE    (default: auto-detected via checkip.amazonaws.com)

set -euo pipefail

PROFILE="${AWS_PROFILE:-bedison}"
REGION="${AWS_REGION:-us-east-1}"
PROJECT="voice-ai-conversation-relay-elevenlabs"
DOMAIN="${DOMAIN:-voice-ai.samueleddy.com}"
ROOT_DOMAIN="${ROOT_DOMAIN:-samueleddy.com}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.micro}"
ROOT_VOLUME_GB="${ROOT_VOLUME_GB:-20}"
SG_NAME="voice-ai-app-sg"
INSTANCE_NAME="voice-ai-app"
EIP_NAME="voice-ai-app-eip"
KEY_NAME="${KEY_NAME:?KEY_NAME env var required (existing EC2 key pair name in $REGION)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_FILE="$SCRIPT_DIR/bootstrap.sh"

log() { printf '\n[setup-aws] %s\n' "$*" >&2; }
aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

# --- preflight ---------------------------------------------------------------

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq not found"      >&2; exit 1; }
[[ -f "$BOOTSTRAP_FILE" ]] || { echo "Missing $BOOTSTRAP_FILE" >&2; exit 1; }

log "Verifying AWS identity (profile=$PROFILE, region=$REGION)..."
aws_ sts get-caller-identity --query 'Account' --output text >/dev/null

log "Verifying EC2 key pair '$KEY_NAME' exists..."
if ! aws_ ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  cat >&2 <<EOF
Key pair '$KEY_NAME' not found in $REGION. Create it first:
  aws --profile $PROFILE --region $REGION ec2 create-key-pair \\
      --key-name $KEY_NAME --query KeyMaterial --output text \\
      > ~/.ssh/$KEY_NAME.pem
  chmod 400 ~/.ssh/$KEY_NAME.pem
EOF
  exit 1
fi

log "Detecting your public IP for SSH ingress..."
MY_IP="${MY_IP_OVERRIDE:-$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')}"
[[ -n "$MY_IP" ]] || { echo "Failed to detect public IP" >&2; exit 1; }
log "  -> $MY_IP/32"

log "Resolving latest AL2023 ARM AMI (SSM)..."
AMI_ID=$(aws_ ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query 'Parameter.Value' --output text)
log "  -> $AMI_ID"

log "Resolving Route 53 hosted zone for $ROOT_DOMAIN..."
HZ_ID=$(aws_ route53 list-hosted-zones-by-name \
  --dns-name "$ROOT_DOMAIN" \
  --query "HostedZones[?Name=='${ROOT_DOMAIN}.'].Id | [0]" --output text \
  | sed 's|/hostedzone/||')
[[ -n "$HZ_ID" && "$HZ_ID" != "None" ]] || { echo "Hosted zone for $ROOT_DOMAIN not found" >&2; exit 1; }
log "  -> $HZ_ID"

log "Resolving default VPC..."
VPC_ID=$(aws_ ec2 describe-vpcs \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
[[ -n "$VPC_ID" && "$VPC_ID" != "None" ]] || { echo "No default VPC found in $REGION" >&2; exit 1; }
log "  -> $VPC_ID"

# --- security group (idempotent) --------------------------------------------

log "Looking up / creating security group '$SG_NAME'..."
SG_ID=$(aws_ ec2 describe-security-groups \
  --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text)

if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
  SG_ID=$(aws_ ec2 create-security-group \
    --group-name "$SG_NAME" \
    --description "voice-ai ref arch app server" \
    --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=$PROJECT},{Key=Name,Value=$SG_NAME}]" \
    --query 'GroupId' --output text)
  log "  -> created $SG_ID"

  aws_ ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${MY_IP}/32,Description=ssh-from-sam}]" >/dev/null
  aws_ ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=http-acme-and-redirect}]" >/dev/null
  aws_ ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description=https}]" >/dev/null
  log "  -> ingress rules added (22 from $MY_IP/32, 80+443 from 0.0.0.0/0)"
else
  log "  -> reusing existing $SG_ID (ingress rules untouched)"
fi

# --- EC2 instance ------------------------------------------------------------

log "Reading user-data from $BOOTSTRAP_FILE..."
USER_DATA=$(cat "$BOOTSTRAP_FILE")

log "Launching EC2 instance ($INSTANCE_TYPE, key=$KEY_NAME, ${ROOT_VOLUME_GB}GB gp3)..."
INSTANCE_ID=$(aws_ ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=$ROOT_VOLUME_GB,VolumeType=gp3,DeleteOnTermination=true}" \
  --user-data "$USER_DATA" \
  --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
  --tag-specifications \
    "ResourceType=instance,Tags=[{Key=Project,Value=$PROJECT},{Key=Name,Value=$INSTANCE_NAME}]" \
    "ResourceType=volume,Tags=[{Key=Project,Value=$PROJECT},{Key=Name,Value=${INSTANCE_NAME}-root}]" \
  --query 'Instances[0].InstanceId' --output text)
log "  -> $INSTANCE_ID, waiting until 'running'..."
aws_ ec2 wait instance-running --instance-ids "$INSTANCE_ID"

# --- Elastic IP --------------------------------------------------------------

log "Allocating Elastic IP..."
ALLOC_OUT=$(aws_ ec2 allocate-address \
  --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Project,Value=$PROJECT},{Key=Name,Value=$EIP_NAME}]")
ALLOC_ID=$(echo "$ALLOC_OUT" | jq -r .AllocationId)
PUBLIC_IP=$(echo "$ALLOC_OUT" | jq -r .PublicIp)
log "  -> $ALLOC_ID  ($PUBLIC_IP)"

log "Associating EIP with $INSTANCE_ID..."
aws_ ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" >/dev/null

# --- Route 53 ----------------------------------------------------------------

log "Upserting Route 53 A record $DOMAIN -> $PUBLIC_IP..."
CHANGE_BATCH=$(jq -n --arg name "$DOMAIN" --arg ip "$PUBLIC_IP" '{
  Comment: "voice-ai ref arch app server",
  Changes: [{
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: $name,
      Type: "A",
      TTL: 300,
      ResourceRecords: [{Value: $ip}]
    }
  }]
}')
CHANGE_ID=$(aws_ route53 change-resource-record-sets \
  --hosted-zone-id "$HZ_ID" \
  --change-batch "$CHANGE_BATCH" \
  --query 'ChangeInfo.Id' --output text)
log "  -> $CHANGE_ID, waiting for INSYNC..."
aws_ route53 wait resource-record-sets-changed --id "$CHANGE_ID"

# --- summary -----------------------------------------------------------------

cat <<EOF

==== voice-ai infra ready ====
  Instance:  $INSTANCE_ID  ($INSTANCE_TYPE, $AMI_ID)
  Public IP: $PUBLIC_IP  (EIP $ALLOC_ID)
  DNS:       $DOMAIN -> $PUBLIC_IP
  SG:        $SG_ID  (ssh from $MY_IP/32, http+https from 0.0.0.0/0)

Next steps:
  1. Tail bootstrap progress (cloud-init runs ~3-5 min on first boot):
       ssh -i ~/.ssh/${KEY_NAME}.pem ec2-user@$PUBLIC_IP \\
           'sudo tail -f /var/log/cloud-init-output.log'
     Wait for: "BOOTSTRAP COMPLETE"

  2. Write /etc/voice-ai.env with TWILIO_*, ANTHROPIC_API_KEY,
     ELEVENLABS_API_KEY, PUBLIC_BASE_URL=https://$DOMAIN, etc.
     A placeholder template was created at /etc/voice-ai.env.example.

  3. Start the app:
       sudo systemctl enable --now voice-ai
       sudo journalctl -u voice-ai -f

  4. Caddy is already up and serving /healthz over HTTPS once voice-ai
     is running. Verify:
       curl https://$DOMAIN/healthz

EOF
