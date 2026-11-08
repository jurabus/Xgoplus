"""Local stand-in for the Supabase API gateway (port 54321).

/auth/v1/*    -> real GoTrue (9999)
/rest/v1/*    -> real PostgREST (3000)
/storage/v1/* -> in-memory object store; every write is checked against the
                 real storage.objects RLS policies by inserting the row as the
                 caller's role.
Publishable keys (sb_publishable_...) are swapped for an anon JWT, like the
real gateway does.
"""
import base64
import email.parser
import hashlib
import hmac
import http.client
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg

SECRET = b"super-secret-jwt-token-with-at-least-32-characters-long"
DSN = "host=/tmp port=5433 user=postgres dbname=xg_e2e"
OBJECTS = {}  # (bucket, path) -> (content_type, bytes)


def b64(d):
    return base64.urlsafe_b64encode(d).rstrip(b"=").decode()


def make_jwt(payload):
    h = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    p = b64(json.dumps(payload).encode())
    sig = b64(hmac.new(SECRET, f"{h}.{p}".encode(), hashlib.sha256).digest())
    return f"{h}.{p}.{sig}"


ANON = make_jwt({"role": "anon", "iss": "supabase", "exp": int(time.time()) + 10 * 365 * 86400})


def verify_jwt(tok):
    try:
        h, p, s = tok.split(".")
        exp = b64(hmac.new(SECRET, f"{h}.{p}".encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(exp, s):
            return None
        claims = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
        if claims.get("exp", 0) < time.time():
            return None
        return claims
    except Exception:
        return None


def extract_file(ctype, body):
    if not ctype.startswith("multipart/form-data"):
        return ctype, body
    msg = email.parser.BytesParser().parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body)
    for part in msg.get_payload():
        if part.get_filename() is not None or part.get_content_type().startswith("image/"):
            return part.get_content_type(), part.get_payload(decode=True)
    return "application/octet-stream", b""


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers") or "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, X-Total-Count, x-supabase-api-version")

    def reply(self, code, body=b"", ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.reply(204, b"", "text/plain")

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def auth_token(self):
        a = self.headers.get("Authorization", "")
        tok = a[7:] if a.lower().startswith("bearer ") else ""
        if not tok or tok.startswith("sb_"):
            return ANON
        return tok

    def proxy(self, port, path):
        data = self.body()
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        hdrs = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "authorization", "content-length", "connection")}
        hdrs["Authorization"] = "Bearer " + self.auth_token()
        hdrs["X-Forwarded-For"] = self.client_ip()
        if data:
            hdrs["Content-Length"] = str(len(data))
        conn.request(self.command, path, body=data or None, headers=hdrs)
        r = conn.getresponse()
        out = r.read()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() not in ("content-length", "transfer-encoding", "connection", "access-control-allow-origin"):
                self.send_header(k, v)
        self.cors()
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def client_ip(self):
        return (self.headers.get("X-Test-Client-IP") or self.headers.get("X-Forwarded-For") or "127.0.0.1").split(",")[0].strip()

    def db_as(self, claims):
        c = psycopg.connect(DSN, autocommit=True)
        return c

    def storage(self):
        from urllib.parse import unquote, urlparse, parse_qs
        raw = urlparse(self.path)
        path = unquote(raw.path[len("/storage/v1/"):])
        if self.command in ("GET", "HEAD") and path.startswith("object/public/"):
            bucket, _, name = path[len("object/public/"):].partition("/")
            with psycopg.connect(DSN, autocommit=True) as c:
                pub = c.execute("select public from storage.buckets where id=%s", (bucket,)).fetchone()
            obj = OBJECTS.get((bucket, name))
            if not obj or not pub or not pub[0]:
                return self.reply(404 if not obj else 400, {"error": "not_found"})
            return self.reply(200, obj[1], obj[0])
        if self.command == "GET" and path.startswith("object/sign/"):
            bucket, _, name = path[len("object/sign/"):].partition("/")
            tok = (parse_qs(raw.query).get("token") or [""])[0]
            try:
                exp, sig = tok.split(".")
                good = hmac.compare_digest(sig, hmac.new(SECRET, f"{bucket}/{name}|{exp}".encode(), hashlib.sha256).hexdigest()) and int(exp) > time.time()
            except ValueError:
                good = False
            obj = OBJECTS.get((bucket, name))
            if not good or not obj:
                return self.reply(400, {"error": "invalid signature"})
            return self.reply(200, obj[1], obj[0])
        claims = verify_jwt(self.auth_token())
        if not claims:
            return self.reply(401, {"error": "invalid jwt"})
        role = claims.get("role", "anon")
        hdr = json.dumps({"x-forwarded-for": self.client_ip()})
        if self.command == "POST" and path.startswith("object/sign/"):
            bucket, _, name = path[len("object/sign/"):].partition("/")
            exp_in = int(json.loads(self.body() or b"{}").get("expiresIn", 60))
            with psycopg.connect(DSN, autocommit=True) as c, c.transaction():
                c.execute("select set_config('request.jwt.claims', %s, true), set_config('request.headers', %s, true)", (json.dumps(claims), hdr))
                c.execute(f"set local role {'authenticated' if role == 'authenticated' else 'anon'}")
                found = c.execute("select 1 from storage.objects where bucket_id=%s and name=%s", (bucket, name)).fetchone()
            if not found:
                return self.reply(400, {"statusCode": "404", "error": "not_found", "message": "Object not found"})
            exp = int(time.time()) + exp_in
            sig = hmac.new(SECRET, f"{bucket}/{name}|{exp}".encode(), hashlib.sha256).hexdigest()
            return self.reply(200, {"signedURL": f"/object/sign/{bucket}/{name}?token={exp}.{sig}"})
        if self.command in ("POST", "PUT") and path.startswith("object/"):
            bucket, _, name = path[len("object/"):].partition("/")
            ctype, data = extract_file(self.headers.get("Content-Type", ""), self.body())
            if len(data) > 2097152:
                return self.reply(413, {"error": "too large", "message": "The object exceeded the maximum allowed size"})
            with psycopg.connect(DSN, autocommit=True) as c:
                lim = c.execute("select file_size_limit from storage.buckets where id=%s", (bucket,)).fetchone()
            if lim and lim[0] and len(data) > lim[0]:
                return self.reply(413, {"error": "too large", "message": "The object exceeded the maximum allowed size"})
            if ctype not in ("image/jpeg", "image/png", "image/webp"):
                return self.reply(415, {"error": "mime", "message": f"mime type {ctype} is not supported"})
            try:
                with psycopg.connect(DSN, autocommit=True) as c, c.transaction():
                    c.execute("select set_config('request.jwt.claims', %s, true), set_config('request.headers', %s, true)", (json.dumps(claims), hdr))
                    c.execute(f"set local role {'authenticated' if role == 'authenticated' else 'anon'}")
                    c.execute("""insert into storage.objects (bucket_id, name, owner) values (%s, %s, %s)
                                 on conflict (bucket_id, name) do update set updated_at = now()""",
                              (bucket, name, claims.get("sub")))
            except psycopg.Error as e:
                return self.reply(403, {"statusCode": "403", "error": "Unauthorized",
                                        "message": "new row violates row-level security policy"})
            OBJECTS[(bucket, name)] = (ctype, data)
            return self.reply(200, {"Key": f"{bucket}/{name}", "Id": name})
        if self.command == "DELETE" and path.startswith("object/"):
            bucket = path[len("object/"):].strip("/")
            names = json.loads(self.body() or b"{}").get("prefixes", [])
            done = []
            with psycopg.connect(DSN, autocommit=True) as c:
                for n in names:
                    with c.transaction():
                        c.execute("select set_config('request.jwt.claims', %s, true), set_config('request.headers', %s, true)", (json.dumps(claims), hdr))
                        c.execute("set local role authenticated")
                        cur = c.execute("delete from storage.objects where bucket_id=%s and name=%s returning name", (bucket, n))
                        if cur.fetchone():
                            OBJECTS.pop((bucket, n), None)
                            done.append({"name": n})
            return self.reply(200, done)
        return self.reply(404, {"error": "unsupported in stand-in"})

    def route(self):
        if self.path.startswith("/auth/v1/"):
            return self.proxy(9999, self.path[len("/auth/v1"):])
        if self.path.startswith("/rest/v1/"):
            return self.proxy(3000, self.path[len("/rest/v1"):])
        if self.path.startswith("/storage/v1/"):
            return self.storage()
        return self.reply(404, {"error": "no route"})

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = route


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 54321), H).serve_forever()
