# Points local/checks/*.py at the dev copy on the server instead of the docker stack.
#   source local/dev/env.sh && python3 local/checks/auth_check.py
# (or just run local/dev/check.sh, which sources this file itself)
_crm_dev_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_crm_dev_root="$(cd "$_crm_dev_here/../.." && pwd)"
_crm_dev_env="${CRM_DEV_ENV:-$_crm_dev_here/api.env}"
_crm_dev_port="$(sed -n 's/^APP_LISTEN_PORT=//p' "$_crm_dev_env" | head -1)"
_crm_dev_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
export CRM_API_URL="http://127.0.0.1:${_crm_dev_port:-3100}/api/v1"
# the same API reached from a non-loopback address (the bot's MCP endpoint must refuse it)
export CRM_API_EXTERNAL_URL="http://${_crm_dev_ip:-127.0.0.1}:${_crm_dev_port:-3100}/api/v1"
export CRM_APP_PORT="${_crm_dev_port:-3100}"
export CRM_PSQL="node $_crm_dev_here/psql.js"
export CRM_APP_EXEC="$_crm_dev_here/in-app.sh"
export CRM_APP_DIR="$_crm_dev_root/parisahon-api"
export CRM_ENV_FILE="$_crm_dev_env"
export CRM_FAKE_TG_URL="http://127.0.0.1:8098"
export CRM_MOCK_CLAUDE_URL="http://127.0.0.1:8099"
# the FTP receiver of call recordings (local/dev/ftp-env.sh): its timings and folders for local/checks/ftp_check.py
export CRM_FTP_ENV_FILE="$_crm_dev_here/ftp.env"
unset _crm_dev_here _crm_dev_root _crm_dev_env _crm_dev_port _crm_dev_ip
