# Saves map captures from the browser for the Figma frames (see FIGMA.md).
# Accepts POST /<name> with raw bytes and writes build/captures/<name>.
# Local only: listens on 127.0.0.1:8099.
#
#   python3 scripts/capture_receiver.py
import http.server, os
OUT = os.path.join(os.path.dirname(__file__), "..", "build", "captures")
os.makedirs(OUT, exist_ok=True)
class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "http://localhost:8080")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        name = os.path.basename(self.path.strip("/")) or "capture.bin"
        data = self.rfile.read(int(self.headers["Content-Length"]))
        open(os.path.join(OUT, name), "wb").write(data)
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b"ok")
http.server.HTTPServer(("127.0.0.1", 8099), H).serve_forever()
