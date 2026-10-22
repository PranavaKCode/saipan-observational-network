#!/usr/bin/env python3
"""Static dev server for the Saipan Observational Network.

`python -m http.server` sends no cache headers at all, which leaves browsers
free to apply heuristic caching. In a project whose JavaScript is loaded as ES
modules with unversioned filenames, that produces a specific and very
confusing failure: you edit a module, reload, and the browser silently keeps
the previous copy. The symptom is an import error naming an export that is
plainly there in the file on disk.

This serves the same directory with caching switched off, so a reload always
means a reload. Production caching is a separate matter and lives in
vercel.json, where the policy is chosen per path.

    python tools/devserver.py [port]
"""

import functools
import http.server
import os
import sys

DEFAULT_PORT = 8777
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with caching disabled and correct MIME types."""

    # Windows registry entries regularly map .js to text/plain, which makes the
    # browser refuse the module. Pin the types the app depends on.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml',
        '.css': 'text/css',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        # The service worker needs this to claim the whole origin, matching
        # what vercel.json sets in production.
        if self.path.rstrip('/').endswith('sw.js'):
            self.send_header('Service-Worker-Allowed', '/')
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request, without the date noise.
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = functools.partial(NoCacheHandler, directory=ROOT)

    # Threaded, like `python -m http.server`. A single-threaded server
    # serialises every request, and this page asks for a dozen modules and
    # data files at once the moment it loads.
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(('', port), handler) as httpd:
        print(f'Saipan Observational Network: http://localhost:{port}')
        print(f'serving {ROOT} with caching disabled')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nstopped')


if __name__ == '__main__':
    main()
