(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { config: null, products: [], category: "الكل", cart: loadCart() };

  function loadCart() {
    try {
      const c = JSON.parse(localStorage.getItem("cart") || "[]");
      return Array.isArray(c) ? c : [];
    } catch { return []; }
  }
  function saveCart() {
    try { localStorage.setItem("cart", JSON.stringify(state.cart)); } catch {}
  }

  // إنشاء عناصر DOM بأمان (textContent فقط، بدون innerHTML)
  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }
  const money = (n) => `${Number(n).toLocaleString("ar-EG")} ${state.config ? state.config.currency : ""}`;

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "حدث خطأ، حاول مرة أخرى");
    return data;
  }

  // ---------- المنتجات ----------
  function renderFilters() {
    const cats = ["الكل", ...new Set(state.products.map((p) => p.category))];
    const box = $("filters");
    box.replaceChildren(
      ...cats.map((c) =>
        el("button", {
          class: "chip" + (c === state.category ? " active" : ""),
          type: "button",
          text: c,
          onclick: () => { state.category = c; renderFilters(); renderProducts(); },
        })
      )
    );
  }

  function renderProducts() {
    const list = state.products.filter((p) => state.category === "الكل" || p.category === state.category);
    const grid = $("grid");
    if (!list.length) {
      grid.replaceChildren(el("p", { class: "muted", text: "لا توجد منتجات متاحة حالياً." }));
      return;
    }
    grid.replaceChildren(
      ...list.map((p) =>
        el("article", { class: "card" },
          el("div", { class: "card-img", "aria-hidden": "true", text: p.emoji }),
          el("div", { class: "card-body" },
            el("span", { class: "card-cat", text: p.category }),
            el("h3", { text: p.name }),
            el("p", { text: p.description }),
            el("div", { class: "card-foot" },
              el("span", { class: "price", text: money(p.price) }),
              el("button", { class: "add-btn", type: "button", text: "أضف للسلة", onclick: () => addToCart(p.id) })
            )
          )
        )
      )
    );
  }

  // ---------- السلة ----------
  function addToCart(id) {
    const item = state.cart.find((i) => i.id === id);
    if (item) item.quantity = Math.min(50, item.quantity + 1);
    else state.cart.push({ id, quantity: 1 });
    saveCart(); renderCart(); toast("تمت الإضافة إلى السلة ✓");
  }
  function changeQty(id, d) {
    const item = state.cart.find((i) => i.id === id);
    if (!item) return;
    item.quantity += d;
    if (item.quantity < 1) state.cart = state.cart.filter((i) => i.id !== id);
    if (item.quantity > 50) item.quantity = 50;
    saveCart(); renderCart();
  }

  function cartLines() {
    // نتجاهل أي منتج لم يعد متوفراً
    return state.cart
      .map((i) => ({ ...i, p: state.products.find((p) => p.id === i.id) }))
      .filter((l) => l.p);
  }
  function totals() {
    const lines = cartLines();
    const subtotal = lines.reduce((s, l) => s + l.p.price * l.quantity, 0);
    const c = state.config;
    const fee = !lines.length || subtotal >= c.free_delivery_over ? 0 : c.delivery_fee;
    return { lines, subtotal, fee, total: subtotal + fee };
  }

  function summaryRows(t) {
    const row = (label, val, cls = "") => el("div", { class: "row " + cls }, el("span", { text: label }), el("span", { text: val }));
    return el("div", { class: "rows" },
      row("المجموع", money(t.subtotal)),
      row("التوصيل", t.fee ? money(t.fee) : "مجاني"),
      row("الإجمالي", money(t.total), "total")
    );
  }

  function renderCart() {
    if (!state.config) return;
    const t = totals();
    const count = t.lines.reduce((s, l) => s + l.quantity, 0);
    $("cartCount").textContent = count.toLocaleString("ar-EG");
    const body = $("cartBody"), foot = $("cartFoot");
    if (!t.lines.length) {
      body.replaceChildren(el("p", { class: "empty", text: "سلتك فارغة، أضف بعض الحلويات 🍰" }));
      foot.replaceChildren();
      return;
    }
    body.replaceChildren(
      ...t.lines.map((l) =>
        el("div", { class: "line" },
          el("div", { class: "em", text: l.p.emoji }),
          el("div", {},
            el("div", { class: "nm", text: l.p.name }),
            el("div", { class: "pr", text: money(l.p.price) })
          ),
          el("div", { class: "qty" },
            el("button", { type: "button", "aria-label": "زيادة", text: "+", onclick: () => changeQty(l.id, 1) }),
            el("span", { text: l.quantity.toLocaleString("ar-EG") }),
            el("button", { type: "button", "aria-label": "نقصان", text: "−", onclick: () => changeQty(l.id, -1) })
          )
        )
      )
    );
    const remaining = state.config.free_delivery_over - t.subtotal;
    foot.replaceChildren(
      summaryRows(t),
      remaining > 0 ? el("p", { class: "hint", text: `أضف ${money(remaining)} للحصول على توصيل مجاني` }) : el("p", { class: "hint", text: "🎉 التوصيل مجاني لطلبك" }),
      el("button", { class: "btn btn-primary btn-block", type: "button", text: "إتمام الطلب", onclick: openCheckout })
    );
  }

  function openDrawer(open) {
    $("drawer").classList.toggle("open", open);
    $("overlay").classList.toggle("show", open);
    $("drawer").setAttribute("aria-hidden", String(!open));
  }

  // ---------- إتمام الطلب ----------
  function openCheckout() {
    openDrawer(false);
    const t = totals();
    if (!t.lines.length) return;
    $("formError").textContent = "";
    $("checkoutSummary").replaceChildren(summaryRows(t));
    $("checkoutModal").classList.add("open");
  }
  function closeCheckout() { $("checkoutModal").classList.remove("open"); }

  async function submitOrder(e) {
    e.preventDefault();
    const form = e.target, err = $("formError"), btn = $("submitOrder");
    const fd = new FormData(form);
    const body = {
      customer_name: fd.get("customer_name").trim(),
      phone: fd.get("phone").trim(),
      address: fd.get("address").trim(),
      notes: fd.get("notes").trim(),
      items: state.cart.map((i) => ({ id: i.id, quantity: i.quantity })),
    };
    if (!body.customer_name || !body.phone || !body.address) {
      err.textContent = "من فضلك املأ الاسم والهاتف والعنوان";
      return;
    }
    err.textContent = "";
    btn.disabled = true; btn.textContent = "جاري إرسال الطلب…";
    try {
      const res = await api("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      state.cart = []; saveCart(); renderCart(); form.reset();
      showSuccess(res);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false; btn.textContent = "تأكيد الطلب (الدفع عند الاستلام)";
    }
  }

  function showSuccess(res) {
    const card = $("checkoutForm");
    const original = [...card.childNodes];
    card.replaceChildren(
      el("div", { class: "success" },
        el("div", { class: "big", text: "🎉" }),
        el("h2", { text: "تم استلام طلبك!" }),
        el("p", { text: `رقم طلبك: ${res.order_id.toLocaleString("ar-EG")}` }),
        el("p", { text: `الإجمالي: ${money(res.total)} — الدفع عند الاستلام` }),
        el("p", { class: "muted", text: "سنتواصل معك قريباً لتأكيد الطلب." }),
        el("button", { class: "btn btn-primary", type: "button", text: "حسناً", onclick: () => { closeCheckout(); card.replaceChildren(...original); } })
      )
    );
  }

  // ---------- التهيئة ----------
  async function init() {
    $("year").textContent = new Date().getFullYear();
    try {
      const [config, products] = await Promise.all([api("/api/config"), api("/api/products")]);
      state.config = config; state.products = products;
    } catch (ex) {
      $("grid").replaceChildren(el("p", { class: "muted", text: "تعذّر تحميل المنتجات. حدّث الصفحة وحاول مرة أخرى." }));
      return;
    }
    const c = state.config;
    document.title = `${c.name} | حلويات طازجة`;
    $("brandName").textContent = `🍰 ${c.name}`;
    $("heroTitle").textContent = c.name;
    $("heroTagline").textContent = c.tagline;
    $("footName").textContent = c.name;
    $("footAddress").textContent = "📍 " + c.address;
    $("footPhone").textContent = "📞 " + c.phone;
    $("waLink").href = `https://wa.me/${encodeURIComponent(c.whatsapp)}`;
    renderFilters(); renderProducts(); renderCart();
  }

  $("openCart").addEventListener("click", () => openDrawer(true));
  $("closeCart").addEventListener("click", () => openDrawer(false));
  $("overlay").addEventListener("click", () => openDrawer(false));
  $("closeCheckout").addEventListener("click", closeCheckout);
  $("checkoutForm").addEventListener("submit", submitOrder);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { openDrawer(false); closeCheckout(); }
  });
  init();
})();
