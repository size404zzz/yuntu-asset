"""参考实现的离线宿主：仓库静态目录 + wiki 上传目录同源代理。

同源是硬要求：AvgPlayer 用 canvas getImageData 读默认脸，跨源图片会污染画布
（方案 R4），代理成同源后 oracle 的行为与 wiki 上完全一致。
"""
import hashlib
import http.server
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

WIKI = 'http://wiki.42lab.cloud'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(ROOT, 'tools', 'ref', 'cache')
UPSTREAM_HEADERS = {'User-Agent': 'Mozilla/5.0 (offline-reference-oracle)'}
SLUG = set('abcdefghijklmnopqrstuvwxyz0123456789_')


def upload_name(quoted):
    """MediaWiki 的 hashed upload dir：md5(空格转下划线) 的首位 + 前两位。

    两种上游形态都要支持：样式表里写的是已经哈希好的 /images/1/1f/x.png，
    getFilePath 造出来的是裸文件名 /images/Lpic_sol_avg.png。
    """
    path = urllib.parse.unquote(quoted).replace(' ', '_')
    parts = path.split('/')
    if (len(parts) >= 3 and len(parts[0]) == 1 and len(parts[1]) == 2
            and all(c in '0123456789abcdef' for c in parts[0] + parts[1])):
        return parts[-1], f'{WIKI}/images/{quoted}'
    name = parts[-1]
    digest = hashlib.md5(name.encode('utf-8')).hexdigest()
    return name, (f'{WIKI}/images/{digest[0]}/{digest[:2]}/'
                  f'{urllib.parse.quote(name)}')


class Handler(http.server.SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith('/images/'):
            return self.serve_upload()
        return super().do_GET()

    def do_HEAD(self):
        if self.path.startswith('/images/'):
            return self.serve_upload(head=True)
        return super().do_HEAD()

    def do_POST(self):
        """oracle 跑完把冻结表写回来，省掉 scrape dump-dom 这一步。"""
        route, _, query = self.path.partition('?')
        if route != '/freeze':
            return self.send_error(404, route)
        scene = dict(urllib.parse.parse_qsl(query)).get('scene', 'scene1')
        if not scene or any(c not in SLUG for c in scene):
            return self.send_error(400, scene)
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        folder = os.path.join(ROOT, 'data', 'fixtures')
        os.makedirs(folder, exist_ok=True)
        target = os.path.join(folder, f'expected-{scene}.json')
        with open(target, 'wb') as handle:
            handle.write(body)
        print(f'freeze -> {target} {len(body)} B', flush=True)
        self.serve_bytes('text/plain', b'ok')

    def serve_upload(self, head=False):
        quoted = self.path[len('/images/'):]
        candidates = []
        name, url = upload_name(quoted)
        candidates.append((name, url))
        capitalized = name[0].upper() + name[1:]
        if capitalized != name:
            digest = hashlib.md5(capitalized.encode('utf-8')).hexdigest()
            candidates.append((
                capitalized,
                f'{WIKI}/images/{digest[0]}/{digest[:2]}/'
                f'{urllib.parse.quote(capitalized)}'))
        local = os.path.join(CACHE, name)
        if os.path.isfile(local):
            self.serve_file(local)
            return
        for _, url in candidates:
            try:
                request = urllib.request.Request(url, headers=UPSTREAM_HEADERS)
                with urllib.request.urlopen(request, timeout=30) as response:
                    body = response.read()
                    content_type = response.headers.get(
                        'Content-Type', 'application/octet-stream')
            except urllib.error.HTTPError:
                continue
            except OSError as error:
                self.send_error(502, str(error))
                return
            # 缺失文件会 302 到一个 HTTP 200 的 HTML 提示页：urllib 追完重定向就
            # 再也分辨不出来，会把错误页当 PNG 缓存掉。只认非 HTML 的响应。
            if not body or 'text/html' in content_type:
                continue
            os.makedirs(CACHE, exist_ok=True)
            with open(local, 'wb') as handle:
                handle.write(body)
            self.serve_bytes(content_type, body, head)
            return
        self.send_error(404, quoted)

    def serve_file(self, path):
        with open(path, 'rb') as handle:
            body = handle.read()
        guess = ('image/png' if path.endswith('.png') else
                 'application/json' if path.endswith('.json') else
                 'font/woff2' if path.endswith('.woff2') else
                 'application/octet-stream')
        self.serve_bytes(guess, body)

    def serve_bytes(self, content_type, body, head=False):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def log_message(self, format, *args):
        if self.path.startswith('/images/') or '--verbose' in sys.argv:
            sys.stderr.write(f'{self.address_string()} {format % args}\n')


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8081
    os.makedirs(CACHE, exist_ok=True)
    print(f'reference oracle on http://127.0.0.1:{port}/  root={ROOT}', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
