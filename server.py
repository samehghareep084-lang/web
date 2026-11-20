#!/usr/bin/env python3
"""بيت الحلو - متجر حلويات: باك إند بمكتبات بايثون الجاهزة فقط (بدون تثبيت أي حزمة).

التشغيل:  python3 server.py
المتجر:   http://localhost:8000
اللوحة:   http://localhost:8000/admin.html

إعدادات اختيارية عبر متغيرات البيئة:
  ADMIN_PASSWORD  كلمة سر لوحة التحكم (الافتراضي: admin123  -- غيّرها!)
  PORT            المنفذ (الافتراضي 8000)
  DB_PATH         مسار ملف قاعدة البيانات (الافتراضي sweets.db)
"""
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DB_PATH = os.environ.get("DB_PATH", str(BASE / "sweets.db"))
PORT = int(os.environ.get("PORT", "8000"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")

# إعدادات المتجر (عدّلها كما تريد)
STORE = {
    "name": "بيت الحلو",
    "tagline": "حلويات طازجة تُصنع بحب كل يوم",
    "currency": "ج.م",
    "whatsapp": "201000000000",  # رقم واتساب بصيغة دولية بدون + أو أصفار
    "phone": "0100 000 0000",
    "address": "شارع الحلويات، المدينة",
    "delivery_fee": 30,
    "free_delivery_over": 400,
}

ORDER_STATUSES = ["جديد", "قيد التحضير", "جاري التوصيل", "تم التسليم", "ملغي"]

SESSIONS = {}  # token -> expiry
SESSION_TTL = 60 * 60 * 8
LOGIN_ATTEMPTS = {}  # ip -> [timestamps]
LOCK = threading.Lock()


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            price INTEGER NOT NULL CHECK (price >= 0),
            emoji TEXT NOT NULL DEFAULT '🍰',
            available INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            address TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            subtotal INTEGER NOT NULL,
            delivery_fee INTEGER NOT NULL,
            total INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'جديد',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            product_id INTEGER,
            product_name TEXT NOT NULL,
            unit_price INTEGER NOT NULL,
            quantity INTEGER NOT NULL
        );
        """
    )
    if conn.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 0:
        seed = [
            ("كنافة نابلسية", "شرقية", "كنافة بالجبنة الطازجة والقطر الخفيف، تُقدَّم ساخنة.", 120, "🥮"),
            ("بقلاوة مشكلة (500 جم)", "شرقية", "بقلاوة بالفستق والجوز والسمن البلدي.", 260, "🍯"),
            ("بسبوسة بالقشطة", "شرقية", "بسبوسة طرية محشوة بالقشطة الطازجة.", 90, "🧁"),
            ("مولتن كيك", "غربية", "كيك الشوكولاتة بقلب سائل ساخن.", 85, "🍫"),
            ("تشيز كيك الفراولة", "غربية", "طبقة كريمية ناعمة مع صوص الفراولة الطبيعي.", 110, "🍓"),
            ("كوكيز الشوكولاتة (6 قطع)", "غربية", "كوكيز مقرمش من الخارج وطري من الداخل.", 70, "🍪"),
            ("كيكة عيد الميلاد (1 كجم)", "كيك", "كيكة فانيليا بكريمة الزبدة، تُزيَّن حسب طلبك.", 450, "🎂"),
            ("كب كيك مشكل (6 قطع)", "كيك", "نكهات فانيليا وشوكولاتة وريد فيلفت.", 130, "🧁"),
            ("أم علي", "شرقية", "أم علي بالمكسرات والقشطة في طاسة فخار.", 75, "🥣"),
            ("قطايف بالمكسرات", "شرقية", "قطايف مقلية أو مخبوزة محشوة بالمكسرات.", 80, "🥟"),
        ]
        conn.executemany(
            "INSERT INTO products (name, category, description, price, emoji) VALUES (?,?,?,?,?)",
            seed,
        )
    conn.commit()
    conn.close()


# ---------- أدوات مساعدة ----------
def clean_text(value, max_len):
    return str(value if value is not None else "").strip()[:max_len]


def parse_product(data):
    name = clean_text(data.get("name"), 100)
    category = clean_text(data.get("category"), 40)
    if not name or not category:
        raise ApiError(400,"الاسم والتصنيف مطلوبان")
    try:
        price = int(data.get("price"))
    except (TypeError, ValueError):
        raise ApiError(400,"السعر غير صحيح")
    if price < 0 or price > 1_000_000:
        raise ApiError(400,"السعر غير صحيح")
    return (
        name,
        category,
        clean_text(data.get("description"), 400),
        price,
        clean_text(data.get("emoji"), 8) or "🍰",
        1 if data.get("available", True) else 0,
    )


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "SweetsServer/1.0"

    def log_message(self, fmt, *args):
        pass

    # ----- إرسال الردود -----
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "طلب غير صالح")
        if length > 100_000:
            raise ApiError(413, "الطلب كبير جداً")
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "بيانات JSON غير صالحة")
        if not isinstance(data, dict):
            raise ApiError(400, "بيانات غير صالحة")
        return data

    # ----- المصادقة -----
    def require_admin(self):
        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        with LOCK:
            expiry = SESSIONS.get(token)
            if not expiry or expiry < time.time():
                SESSIONS.pop(token, None)
                raise ApiError(401, "غير مصرّح، سجّل الدخول من جديد")

    def login(self, data):
        ip = self.client_address[0]
        now = time.time()
        with LOCK:
            attempts = [t for t in LOGIN_ATTEMPTS.get(ip, []) if now - t < 300]
            if len(attempts) >= 8:
                raise ApiError(429, "محاولات كثيرة، جرّب بعد بضع دقائق")
            attempts.append(now)
            LOGIN_ATTEMPTS[ip] = attempts
        given = hashlib.sha256(str(data.get("password", "")).encode()).digest()
        real = hashlib.sha256(ADMIN_PASSWORD.encode()).digest()
        if not hmac.compare_digest(given, real):
            raise ApiError(401, "كلمة السر غير صحيحة")
        token = secrets.token_urlsafe(32)
        with LOCK:
            SESSIONS[token] = now + SESSION_TTL
            LOGIN_ATTEMPTS.pop(ip, None)
        return {"token": token}

    # ----- منطق الـ API -----
    def create_order(self, data):
        name = clean_text(data.get("customer_name"), 80)
        phone = clean_text(data.get("phone"), 20)
        address = clean_text(data.get("address"), 250)
        notes = clean_text(data.get("notes"), 300)
        items = data.get("items")
        if not name or not phone or not address:
            raise ApiError(400, "الاسم والهاتف والعنوان مطلوبة")
        digits = [c for c in phone if c.isdigit()]
        if len(digits) < 7 or len(digits) > 15:
            raise ApiError(400, "رقم الهاتف غير صحيح")
        if not isinstance(items, list) or not items or len(items) > 50:
            raise ApiError(400, "السلة فارغة")

        conn = db()
        try:
            lines, subtotal = [], 0
            for it in items:
                try:
                    pid, qty = int(it.get("id")), int(it.get("quantity"))
                except (TypeError, ValueError, AttributeError):
                    raise ApiError(400, "عناصر السلة غير صحيحة")
                if qty < 1 or qty > 50:
                    raise ApiError(400, "الكمية غير صحيحة")
                p = conn.execute(
                    "SELECT * FROM products WHERE id=? AND available=1", (pid,)
                ).fetchone()
                if not p:
                    raise ApiError(400, "أحد المنتجات لم يعد متوفراً")
                # السعر يؤخذ دائماً من قاعدة البيانات وليس من العميل
                lines.append((p["id"], p["name"], p["price"], qty))
                subtotal += p["price"] * qty
            fee = 0 if subtotal >= STORE["free_delivery_over"] else STORE["delivery_fee"]
            total = subtotal + fee
            cur = conn.execute(
                "INSERT INTO orders (customer_name, phone, address, notes, subtotal, delivery_fee, total)"
                " VALUES (?,?,?,?,?,?,?)",
                (name, phone, address, notes, subtotal, fee, total),
            )
            oid = cur.lastrowid
            conn.executemany(
                "INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)"
                " VALUES (?,?,?,?,?)",
                [(oid, *line) for line in lines],
            )
            conn.commit()
            return {"order_id": oid, "total": total, "delivery_fee": fee}
        finally:
            conn.close()

    def list_orders(self):
        conn = db()
        try:
            orders = [
                row_to_dict(r)
                for r in conn.execute("SELECT * FROM orders ORDER BY id DESC LIMIT 300")
            ]
            for o in orders:
                o["items"] = [
                    row_to_dict(r)
                    for r in conn.execute(
                        "SELECT product_name, unit_price, quantity FROM order_items WHERE order_id=?",
                        (o["id"],),
                    )
                ]
            return orders
        finally:
            conn.close()

    # ----- التوجيه -----
    def route(self, method, path):
        conn = None
        if method == "GET" and path == "/api/config":
            return 200, {**STORE, "statuses": ORDER_STATUSES}
        if method == "GET" and path == "/api/products":
            conn = db()
            rows = conn.execute(
                "SELECT id,name,category,description,price,emoji FROM products"
                " WHERE available=1 ORDER BY category, id"
            ).fetchall()
            conn.close()
            return 200, [row_to_dict(r) for r in rows]
        if method == "POST" and path == "/api/orders":
            return 201, self.create_order(self.read_json())
        if method == "POST" and path == "/api/admin/login":
            return 200, self.login(self.read_json())

        if path.startswith("/api/admin/"):
            self.require_admin()
            if method == "GET" and path == "/api/admin/products":
                conn = db()
                rows = conn.execute("SELECT * FROM products ORDER BY category, id").fetchall()
                conn.close()
                return 200, [row_to_dict(r) for r in rows]
            if method == "POST" and path == "/api/admin/products":
                values = parse_product(self.read_json())
                conn = db()
                cur = conn.execute(
                    "INSERT INTO products (name,category,description,price,emoji,available)"
                    " VALUES (?,?,?,?,?,?)",
                    values,
                )
                conn.commit()
                conn.close()
                return 201, {"id": cur.lastrowid}
            if path.startswith("/api/admin/products/"):
                try:
                    pid = int(path.rsplit("/", 1)[1])
                except ValueError:
                    raise ApiError(404, "غير موجود")
                if method == "PUT":
                    values = parse_product(self.read_json())
                    conn = db()
                    cur = conn.execute(
                        "UPDATE products SET name=?,category=?,description=?,price=?,emoji=?,available=?"
                        " WHERE id=?",
                        (*values, pid),
                    )
                    conn.commit()
                    conn.close()
                    if cur.rowcount == 0:
                        raise ApiError(404, "المنتج غير موجود")
                    return 200, {"ok": True}
                if method == "DELETE":
                    conn = db()
                    cur = conn.execute("DELETE FROM products WHERE id=?", (pid,))
                    conn.commit()
                    conn.close()
                    if cur.rowcount == 0:
                        raise ApiError(404, "المنتج غير موجود")
                    return 200, {"ok": True}
            if method == "GET" and path == "/api/admin/orders":
                return 200, self.list_orders()
            if method == "PUT" and path.startswith("/api/admin/orders/"):
                try:
                    oid = int(path.rsplit("/", 1)[1])
                except ValueError:
                    raise ApiError(404, "غير موجود")
                status = clean_text(self.read_json().get("status"), 30)
                if status not in ORDER_STATUSES:
                    raise ApiError(400, "حالة غير صحيحة")
                conn = db()
                cur = conn.execute("UPDATE orders SET status=? WHERE id=?", (status, oid))
                conn.commit()
                conn.close()
                if cur.rowcount == 0:
                    raise ApiError(404, "الطلب غير موجود")
                return 200, {"ok": True}
        raise ApiError(404, "غير موجود")

    def handle_api(self, method):
        path = urlparse(self.path).path.rstrip("/") or "/"
        try:
            status, payload = self.route(method, path)
            self.send_json(status, payload)
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except Exception as e:  # noqa
            print("خطأ داخلي:", repr(e))
            self.send_json(500, {"error": "حدث خطأ في الخادم"})

    # ----- الملفات الثابتة -----
    def serve_static(self):
        path = urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        target = (STATIC / path.lstrip("/")).resolve()
        if STATIC.resolve() not in target.parents or not target.is_file():
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("الصفحة غير موجودة".encode("utf-8"))
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self.handle_api("GET")
        else:
            self.serve_static()

    def do_POST(self):
        self.handle_api("POST") if self.path.startswith("/api/") else self.send_error(404)

    def do_PUT(self):
        self.handle_api("PUT") if self.path.startswith("/api/") else self.send_error(404)

    def do_DELETE(self):
        self.handle_api("DELETE") if self.path.startswith("/api/") else self.send_error(404)


def main():
    init_db()
    if ADMIN_PASSWORD == "admin123":
        print("⚠️  تنبيه: تستخدم كلمة السر الافتراضية. عيّن ADMIN_PASSWORD قبل النشر.")
    print(f"✅ المتجر يعمل على http://localhost:{PORT}")
    print(f"🔐 لوحة التحكم: http://localhost:{PORT}/admin.html")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
