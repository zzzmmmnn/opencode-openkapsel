"""Fixed stdin transport for the upstream REST helpers (no host code tool)."""
import contextlib
import io
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener, install_opener

# Pipes must have the same encoding on every host. In particular, Windows may
# otherwise decode Node's UTF-8 JSON stdin with its active legacy code page.
sys.stdin.reconfigure(encoding='utf-8', errors='strict')
sys.stdout.reconfigure(encoding='utf-8', errors='strict')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor/openkapsel-rest/scripts'))
import openkapsel_config as config
import openkapsel_http as http


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    install_opener(build_opener(NoRedirect()))
    payload = json.load(sys.stdin)
    credential_file = Path.cwd() / '.openkapsel.env'
    secrets = []
    if credential_file.exists():
        values = config.read_env_file(credential_file)
        secrets.extend(values.get(key, '') for key in (config.BASE_URL_KEY, config.CONTROL_TOKEN_KEY))
    output = io.TextIOWrapper(io.BytesIO(), encoding='utf-8')
    try:
        if payload['action'] == 'init':
            secrets.extend([payload['workspace_url'], payload['control_token']])
            _, action = config.initialize_env_file(payload['workspace_url'], payload['control_token'], force=payload.get('force', False))
            result = {'action': action}
        elif payload['action'] == 'http':
            endpoint = payload['endpoint']
            credentials = config.resolve_credentials(env_file=credential_file)
            parsed = urlsplit(endpoint)
            if parsed.scheme or parsed.netloc:
                base = urlsplit(credentials.base_url)
                if (parsed.scheme, parsed.netloc) != (base.scheme, base.netloc):
                    raise ValueError('absolute URLs must use the configured OpenKapsel origin')
                prefix = base.path.rsplit('/w/', 1)[0] + '/transfer/'
                if not parsed.path.startswith(prefix):
                    raise ValueError('absolute URLs are allowed only for OpenKapsel transfer tickets')
            args = [payload['method'], endpoint, '--env-file', str(credential_file), '--auth', 'control']
            for key, value in payload.get('query', {}).items():
                if value is not None:
                    args.extend(['--query', f'{key}={str(value).lower() if isinstance(value, bool) else value}'])
            if 'json' in payload:
                args.extend(['--json', json.dumps(payload['json'])])
            for key in ('plan_id', 'taskname', 'message'):
                if key in payload:
                    args.extend(['--' + key.replace('_', '-'), str(payload[key])])
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                code = http.main(args)
            output.flush()
            text = output.buffer.getvalue().decode('utf-8', errors='replace').strip()
            if code:
                raise ValueError(text or 'OpenKapsel request failed')
            try:
                result = json.loads(text)
            except ValueError:
                result = text
        else:
            raise ValueError('unsupported helper action')
        envelope = {'result': result}
    except Exception as exc:
        envelope = {'error': str(exc)}
    # Renewal can replace both tokens; redact old and newly persisted values.
    if credential_file.exists():
        values = config.read_env_file(credential_file)
        secrets.extend(values.get(key, '') for key in (config.BASE_URL_KEY, config.CONTROL_TOKEN_KEY))
    encoded = json.dumps(envelope, ensure_ascii=True)
    for value in secrets:
        if not value:
            continue
        candidates = [value]
        if '/w/' in value:
            candidates.append(value.rstrip('/').rsplit('/', 1)[-1])
        for candidate in candidates:
            encoded = encoded.replace(json.dumps(candidate, ensure_ascii=True)[1:-1], '[REDACTED]')
    encoded = encoded.replace(json.dumps(str(Path.cwd()))[1:-1], '[private state]')
    encoded = re.sub(r'(/w/)[A-Za-z0-9_-]+', r'\1[REDACTED]', encoded)
    sys.stdout.write(encoded)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stdout.write(json.dumps({'error': 'OpenKapsel helper failed; check configuration and credential file permissions'}))
        sys.exit(1)
