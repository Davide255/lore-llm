#!/usr/bin/env bash
# Deploys the study Lambda with the plain AWS CLI, for accounts where CloudFormation/SAM
# is not available. Idempotent: creates what is missing, otherwise updates code and config.
#
#   LORE_API_URL=https://<worker>.workers.dev ./scripts/deploy.sh
#
# Needs: the Anthropic key in SSM (SecureString, default /ai/anthropic-api-key), and
#   iam:GetRole, iam:CreateRole, iam:PutRolePolicy, iam:AttachRolePolicy, iam:PassRole   on role $ROLE
#   lambda:GetFunction, CreateFunction, UpdateFunctionCode, UpdateFunctionConfiguration,
#   lambda:GetFunctionUrlConfig, CreateFunctionUrlConfig, AddPermission                   on function $FUNCTION
# Prints the Function URL: set it as STUDY_LAMBDA_URL in the Worker (wrangler.toml [vars]).
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-north-1}}"
FUNCTION="${FUNCTION:-lore-llm-study}"
ROLE="${ROLE:-lore-llm-study-role}"
KEY_PARAM="${ANTHROPIC_KEY_PARAM:-/ai/anthropic-api-key}"
MODEL="${STUDY_MODEL:-claude-sonnet-5-5}"
POOL="${COGNITO_USER_POOL_ID:-eu-north-1_orShbeG8H}"
CLIENTS="${COGNITO_CLIENT_IDS:-97beb3qgebbmbqrnr0erhs37v,2ij9dpmj7gacqj370obj0lehg2,730nauiaj6dc4dfjdrfvrd7eak}"
: "${LORE_API_URL:?set LORE_API_URL to the Worker base URL}"
aws() { command aws --region "$REGION" "$@"; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PARAM_ARN="arn:aws:ssm:${REGION}:${ACCOUNT}:parameter${KEY_PARAM}"

echo "› build"
npm run build --silent
rm -f dist/function.zip
(cd dist && zip -q function.zip handler.mjs)

echo "› role $ROLE"
if ! ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text 2>/dev/null); then
  ROLE_ARN=$(aws iam create-role --role-name "$ROLE" --query Role.Arn --output text \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}')
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "  created; waiting for IAM to propagate"
  sleep 10
fi
# Only the one parameter; a SecureString under the AWS managed aws/ssm key needs no kms grant.
aws iam put-role-policy --role-name "$ROLE" --policy-name read-anthropic-key \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"${PARAM_ARN}\"}]}"

ENV_JSON=$(node -e '
  const [pool, clients, url, param, model] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ Variables: { COGNITO_USER_POOL_ID: pool, COGNITO_CLIENT_IDS: clients, LORE_API_URL: url, ANTHROPIC_API_KEY_PARAM: param, STUDY_MODEL: model } }));
' "$POOL" "$CLIENTS" "$LORE_API_URL" "$KEY_PARAM" "$MODEL")

echo "› function $FUNCTION"
if aws lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNCTION" --zip-file fileb://dist/function.zip >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION"
  aws lambda update-function-configuration --function-name "$FUNCTION" --environment "$ENV_JSON" \
    --timeout 600 --memory-size 1024 >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION"
else
  aws lambda create-function --function-name "$FUNCTION" --runtime nodejs22.x --architectures arm64 \
    --handler handler.handler --role "$ROLE_ARN" --zip-file fileb://dist/function.zip \
    --timeout 600 --memory-size 1024 --environment "$ENV_JSON" >/dev/null
  aws lambda wait function-active-v2 --function-name "$FUNCTION"
fi

echo "› function URL"
if ! URL=$(aws lambda get-function-url-config --function-name "$FUNCTION" --query FunctionUrl --output text 2>/dev/null); then
  # The token is verified in code, like the Worker does: a Function URL can't use a Cognito authorizer.
  URL=$(aws lambda create-function-url-config --function-name "$FUNCTION" --auth-type NONE --invoke-mode RESPONSE_STREAM \
    --query FunctionUrl --output text)
  aws lambda add-permission --function-name "$FUNCTION" --statement-id public-url \
    --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --function-name "$FUNCTION" --statement-id public-url-invoke \
    --action lambda:InvokeFunction --principal '*' --invoked-via-function-url >/dev/null
fi

echo
echo "Study Lambda: $URL"
echo "Set it in the Worker: STUDY_LAMBDA_URL = \"$URL\" (wrangler.toml [vars]), then deploy the Worker."
