(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem("admin_token") || "";
  let config = { currency: "", statuses: [] };
  let products = [];
  let editingId = null;

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
  const money = (n) => `${Number(n).toLocaleString("ar-EG")} ${config.currency}`;
  const fmtDate = (s) => {
    const d = new Date(s.replace(" ", "T") + "Z");
    return isNaN(d) ? s : d.toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" });
  };
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2000);
  }

  async function api(path, method = "GET", body) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/api/admin/login") { logout(); throw new Error(data.error || "انتهت الجلسة"); }
    if (!res.ok) throw new Error(data.error || "حدث خطأ");
    return data;
  }

  // ---------- الدخول ----------
  function showDash(show) {
    $("loginView").classList.toggle("hidden", show);
    $("dashView").classList.toggle("hidden", !show);
  }
  function logout() {
    token = ""; sessionStorage.removeItem("admin_token"); showDash(false);
  }
  $("logout").addEventListener("click", logout);

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("loginErr").textContent = "";
    try {
      const r = await api("/api/admin/login", "POST", { password: $("pw").value });
      token = r.token; sessionStorage.setItem("admin_token", token);
      $("pw").value = "";
      await loadAll();
    } catch (ex) { $("loginErr").textContent = ex.message; }
  });

  // ---------- تحميل البيانات ----------
  async function loadAll() {
    const [cfg, prods, orders] = await Promise.all([
      fetch("/api/config").then((r) => r.json()),
      api("/api/admin/products"),
      api("/api/admin/orders"),
    ]);
    config = cfg; products = prods;
    showDash(true);
    renderStats(orders); renderOrders(orders); renderProducts();
  }

  function renderStats(orders) {
    const active = orders.filter((o) => o.status !== "ملغي");
    const today = new Date().toISOString().slice(0, 10);
    const todays = active.filter((o) => o.created_at.startsWith(today));
    const stat = (label, val) => el("div", { class: "stat" }, el("b", { text: val }), el("span", { class: "muted", text: label }));
    $("stats").replaceChildren(
      stat("طلبات جديدة", orders.filter((o) => o.status === "جديد").length.toLocaleString("ar-EG")),
      stat("طلبات اليوم", todays.length.toLocaleString("ar-EG")),
      stat("مبيعات اليوم", money(todays.reduce((s, o) => s + o.total, 0))),
      stat("إجمالي المبيعات", money(active.reduce((s, o) => s + o.total, 0)))
    );
  }

  // ---------- الطلبات ----------
  function renderOrders(orders) {
    const box = $("orders");
    if (!orders.length) { box.replaceChildren(el("p", { class: "muted", text: "لا توجد طلبات بعد." })); return; }
    box.replaceChildren(
      ...orders.map((o) => {
        const sel = el("select", { class: "st", "aria-label": "حالة الطلب" },
          ...config.statuses.map((s) => { const op = el("option", { value: s, text: s }); if (s === o.status) op.selected = true; return op; })
        );
        sel.addEventListener("change", async () => {
          try { await api(`/api/admin/orders/${o.id}`, "PUT", { status: sel.value }); toast("تم تحديث الحالة ✓"); await loadAll(); }
          catch (ex) { toast(ex.message); }
        });
        return el("div", { class: "order" },
          el("div", { class: "order-head" },
            el("strong", { text: `طلب #${o.id.toLocaleString("ar-EG")} — ${o.customer_name}` }),
            el("span", { class: "muted", text: fmtDate(o.created_at) }),
            sel
          ),
          el("div", {}, el("a", { href: "tel:" + o.phone.replace(/[^\d+]/g, ""), text: "📞 " + o.phone, dir: "ltr" }), " · 📍 " + o.address),
          o.notes ? el("div", { class: "muted", text: "ملاحظات: " + o.notes }) : null,
          el("ul", {}, ...o.items.map((i) => el("li", { text: `${i.product_name} × ${i.quantity.toLocaleString("ar-EG")} — ${money(i.unit_price * i.quantity)}` }))),
          el("strong", { text: `الإجمالي: ${money(o.total)}  (توصيل: ${o.delivery_fee ? money(o.delivery_fee) : "مجاني"})` })
        );
      })
    );
  }

  // ---------- المنتجات ----------
  function renderProducts() {
    const head = el("thead", {}, el("tr", {}, ...["", "الاسم", "التصنيف", "السعر", "الحالة", ""].map((h) => el("th", { text: h }))));
    const body = el("tbody", {}, ...products.map((p) =>
      el("tr", {},
        el("td", { text: p.emoji }),
        el("td", { text: p.name }),
        el("td", { text: p.category }),
        el("td", { text: money(p.price) }),
        el("td", {}, el("span", { class: "tag" + (p.available ? "" : " off"), text: p.available ? "متوفر" : "مخفي" })),
        el("td", {},
          el("button", { class: "sm", type: "button", text: "تعديل", onclick: () => startEdit(p) }), " ",
          el("button", { class: "sm danger", type: "button", text: "حذف", onclick: () => removeProduct(p) })
        )
      )
    ));
    $("prodTable").replaceChildren(head, body);
    $("cats").replaceChildren(...[...new Set(products.map((p) => p.category))].map((c) => el("option", { value: c })));
  }

  const form = $("productForm");
  function resetForm() {
    editingId = null; form.reset(); form.emoji.value = "🍰"; form.available.checked = true;
    $("formTitle").textContent = "إضافة منتج جديد"; $("cancelEdit").hidden = true; $("prodErr").textContent = "";
  }
  function startEdit(p) {
    editingId = p.id;
    form.name.value = p.name; form.category.value = p.category; form.price.value = p.price;
    form.emoji.value = p.emoji; form.description.value = p.description; form.available.checked = !!p.available;
    $("formTitle").textContent = "تعديل: " + p.name; $("cancelEdit").hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  $("cancelEdit").addEventListener("click", resetForm);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("prodErr").textContent = "";
    const body = {
      name: form.name.value, category: form.category.value, price: form.price.value,
      emoji: form.emoji.value, description: form.description.value, available: form.available.checked,
    };
    try {
      if (editingId) await api(`/api/admin/products/${editingId}`, "PUT", body);
      else await api("/api/admin/products", "POST", body);
      toast("تم الحفظ ✓"); resetForm(); await loadAll();
    } catch (ex) { $("prodErr").textContent = ex.message; }
  });

  async function removeProduct(p) {
    if (!confirm(`حذف "${p.name}" نهائياً؟ (يمكنك بدلاً من ذلك إخفاءه بإلغاء خيار "متوفر")`)) return;
    try { await api(`/api/admin/products/${p.id}`, "DELETE"); toast("تم الحذف"); await loadAll(); }
    catch (ex) { toast(ex.message); }
  }

  // بدء التشغيل
  if (token) loadAll().catch(() => showDash(false)); else showDash(false);
})();
