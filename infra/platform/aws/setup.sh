#!/usr/bin/env bash
# Create (or update) the Swarm KMS key, platform identity and backup bucket in the current AWS account.
# Usage: AWS_PROFILE=<admin profile> ./infra/platform/aws/setup.sh <staging|production> <region> <unique-bucket-name>
# Prints the values to put into the Fly secrets of the platform, provisioner and gateway apps. Run once per environment.
set -euo pipefail
env_name="${1:?staging|production}"; region="${2:?region, e.g. us-east-1}"; bucket="${3:?globally unique bucket name}"
stack="swarm-${env_name}-platform-kms"
here="$(cd "$(dirname "$0")" && pwd)"
aws cloudformation deploy --region "$region" --stack-name "$stack" --template-file "$here/swarm-platform-kms.cfn.yaml" \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides "Environment=$env_name" "BackupBucketName=$bucket" --no-fail-on-empty-changeset
out() { aws cloudformation describe-stacks --region "$region" --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
key_arn="$(out TenantKmsKeyId)"; user="$(out PlatformUserName)"
# One access key for the platform identity. Rotate by creating a new one, updating Fly secrets, then deleting the old.
existing="$(aws iam list-access-keys --user-name "$user" --query 'AccessKeyMetadata[].AccessKeyId' --output text)"
if [[ -n "$existing" ]]; then
  echo "Access key(s) already exist for $user: $existing. Reuse the secret you stored, or delete one and rerun." >&2
  key_json=''
else
  key_json="$(aws iam create-access-key --user-name "$user" --output json)"
fi
umask 077
secrets_file="${SWARM_SECRETS_FILE:-$HOME/.swarm-${env_name}-aws.env}"
{
  echo "TENANT_KMS_KEY_ID=$key_arn"
  echo "AWS_REGION=$region"
  echo "BACKUP_BUCKET=$bucket"
  if [[ -n "$key_json" ]]; then
    echo "AWS_ACCESS_KEY_ID=$(printf '%s' "$key_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["AccessKey"]["AccessKeyId"])')"
    echo "AWS_SECRET_ACCESS_KEY=$(printf '%s' "$key_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["AccessKey"]["SecretAccessKey"])')"
  fi
} > "$secrets_file"
echo "Wrote $secrets_file (mode 0600). Import into each platform role with: flyctl secrets import --stage -a <app> < $secrets_file"
echo "Then verify the key with: AWS_PROFILE=<admin or platform> node infra/platform/aws/verify-kms.mjs $key_arn"
