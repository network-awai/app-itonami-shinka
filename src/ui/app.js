// Generic local UI for an itonami app. It renders one form per action declared
// in app-def.js and lists the records the app keeps on this device. It builds
// DOM from text nodes only (no HTML strings) and makes no network request.
import { LocalStore } from "./local-store.js";
import { app } from "./app-def.js";

function storage() { try { return globalThis.localStorage ?? null; } catch { return null; } }
const local = storage();
const store = new LocalStore({ did: app.did, storage: local, key: app.storageKey });
const ui = { tab: "actions", result: null, error: null };

const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
};

function readField(field, form) {
  const input = form.elements.namedItem(field.name);
  if (!input) return undefined;
  const raw = field.type === "checkbox" ? input.checked : input.value.trim();
  if (field.type === "checkbox") return raw;
  if (raw === "") return undefined;
  if (field.type === "number") { const n = Number(raw); return Number.isFinite(n) ? n : raw; }
  if (field.type === "list") return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (field.type === "json") { try { return JSON.parse(raw); } catch { throw new Error(`${field.label}: JSON として読めません`); } }
  return raw;
}

function fieldControl(action, field) {
  const common = { name: field.name, id: `f-${action.name}-${field.name}`, required: !!field.required };
  if (field.type === "textarea" || field.type === "json" || field.type === "list") return el("textarea", { ...common, rows: field.rows ?? 3, placeholder: field.placeholder ?? "" });
  if (field.type === "select") return el("select", common, ...(field.required ? [] : [el("option", { value: "" }, "—")]), ...field.options.map((o) => el("option", { value: o }, o)));
  if (field.type === "checkbox") return el("input", { ...common, type: "checkbox", required: false });
  return el("input", { ...common, type: field.type === "number" ? "number" : "text", step: field.step ?? "any", placeholder: field.placeholder ?? "" });
}

async function runAction(action, form) {
  ui.error = null; ui.result = null;
  try {
    const input = {};
    for (const field of action.fields) { const v = readField(field, form); if (v !== undefined) input[field.name] = v; }
    ui.result = { action: action.label, output: await action.run(store, input) };
  } catch (error) {
    ui.error = error?.message ?? String(error);
  }
  // Only the result panel changes: the forms keep what was typed.
  renderNotice();
  document.getElementById("notice").scrollIntoView({ block: "nearest" });
}

function actionCard(action) {
  const form = el("form", { class: "card", onsubmit: (ev) => { ev.preventDefault(); runAction(action, form); } },
    el("h3", {}, action.label),
    action.help ? el("p", { class: "muted" }, action.help) : null,
    ...action.fields.map((field) => el("label", { for: `f-${action.name}-${field.name}` },
      el("span", {}, field.label + (field.required ? " *" : "")), fieldControl(action, field))),
    el("button", { type: "submit" }, "実行"));
  return form;
}

function resultPanel() {
  if (ui.error) return el("div", { class: "notice error", role: "alert" }, ui.error);
  if (!ui.result) return null;
  return el("div", { class: "notice" }, el("strong", {}, ui.result.action), el("pre", {}, JSON.stringify(ui.result.output, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2)));
}

function recordsView() {
  return el("div", { class: "records" }, ...app.collections.map((c) => {
    const rows = store.list(c.name);
    return el("section", { class: "card" },
      el("h3", {}, `${c.label} (${rows.length})`),
      el("p", { class: "muted mono" }, c.name),
      rows.length === 0 ? el("p", { class: "muted" }, "まだありません") :
        el("ul", {}, ...rows.slice(-50).reverse().map((r) => el("li", {}, el("code", {}, r.rkey), el("pre", {}, JSON.stringify(r.value, null, 2))))));
  }));
}

function aboutView() {
  return el("section", { class: "card" },
    el("h3", {}, app.title),
    el("p", {}, app.description),
    el("p", { class: "muted" }, "データはこの端末の中だけに保存されます（localStorage）。外部への通信はしません。"),
    el("p", { class: "muted mono" }, app.did),
    // Two-step reset instead of window.confirm(), which some OS WebViews do not show.
    el("button", { type: "button", class: "danger", onclick: () => {
      if (!ui.armReset) { ui.armReset = true; render(); return; }
      ui.armReset = false;
      try { store.clear(); ui.result = null; ui.error = null; } catch (e) { ui.error = e.message; }
      render();
    } }, ui.armReset ? "もう一度押すと、この端末の記録をすべて消します" : "記録をすべて消す"));
}

const TABS = [["actions", "操作"], ["records", "記録"], ["about", "このアプリ"]];

function render() {
  document.title = app.title;
  document.getElementById("title").textContent = app.title;
  const tabs = document.getElementById("tabs");
  tabs.replaceChildren(...TABS.map(([id, label]) => el("button", { type: "button", role: "tab", "aria-selected": ui.tab === id ? "true" : "false", onclick: () => { ui.tab = id; render(); } }, label)));
  renderNotice();
  const view = document.getElementById("view");
  if (ui.tab === "actions") view.replaceChildren(el("div", { class: "grid" }, ...app.actions.map(actionCard)));
  else if (ui.tab === "records") view.replaceChildren(recordsView());
  else view.replaceChildren(aboutView());
}

function renderNotice() {
  const notice = document.getElementById("notice");
  const saveError = !local ? "この環境では保存できません。記録はこの画面を閉じると消えます。" : store.lastSaveError ? "保存に失敗しました: " + store.lastSaveError.message : null;
  notice.replaceChildren(...[saveError ? el("div", { class: "notice error" }, saveError) : null, resultPanel()].filter(Boolean));
}

render();
const tauri = globalThis.__TAURI__;
if (tauri?.core?.invoke) tauri.core.invoke("awai_host_info").then((info) => { document.getElementById("env").textContent = info?.app ?? ""; }).catch(() => {});
