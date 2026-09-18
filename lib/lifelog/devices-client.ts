/**
 * Devices page client: manage capture-policy provisioning tokens for the
 * recorder app. Lists issued tokens, issues new ones, revokes. A freshly
 * issued policy URL is shown once with a "Show QR" button; the QR is
 * rendered client-side from the URL so the capture app can scan it.
 *
 * The page and every API it touches sit behind the full-access gate; the
 * policy URL is a capability secret and never appears in server-rendered HTML.
 */
import qrcode = require("qrcode-generator");

type Token = {
  readonly id: string;
  readonly label: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const fmtDate = (ms: number): string => new Date(ms).toLocaleString();

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

const refresh = (): void => {
  api<{ tokens: ReadonlyArray<Token> }>("/api/capture-policy/tokens")
    .then(({ tokens }) => renderTokens(tokens))
    .catch((e: unknown) => {
      el("token-list").innerHTML = `<p class="error">Could not load device URLs: ${escapeHtml(String(e))}</p>`;
    });
};

const renderTokens = (tokens: ReadonlyArray<Token>): void => {
  const list = el("token-list");
  if (tokens.length === 0) {
    list.innerHTML = `<p class="empty">No device URLs issued yet.</p>`;
    return;
  }
  list.innerHTML = [...tokens]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => {
      const status = t.revokedAt ? `revoked ${fmtDate(t.revokedAt)}` : "active";
      const used = t.lastUsedAt ? ` · last used ${fmtDate(t.lastUsedAt)}` : "";
      const revoke = t.revokedAt ? "" : ` <button type="button" data-revoke="${escapeHtml(t.id)}">Revoke</button>`;
      return (
        `<div class="token-row"><div><strong>${escapeHtml(t.label)}</strong><br>` +
        `<span class="stale">${escapeHtml(t.id)} · issued ${escapeHtml(fmtDate(t.createdAt))} · ${escapeHtml(status)}${escapeHtml(used)}</span></div>` +
        `<div>${revoke}</div></div>`
      );
    })
    .join("");
  list.querySelectorAll("[data-revoke]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = (btn as HTMLElement).dataset["revoke"];
      if (!id) return;
      if (!window.confirm("Revoke this device URL? The recorder using it will stop receiving policy updates.")) return;
      api<unknown>(`/api/capture-policy/tokens/${encodeURIComponent(id)}/revoke`, { method: "POST" })
        .then(refresh)
        .catch((e: unknown) => {
          list.insertAdjacentHTML("beforeend", `<p class="error">${escapeHtml(String(e))}</p>`);
        });
    });
  });
};

const showQr = (url: string): void => {
  const box = el("qr");
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  box.innerHTML = qr.createSvgTag(6, 8);
  box.hidden = false;
};

const main = (): void => {
  refresh();

  el<HTMLFormElement>("issue-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const err = el("issue-error");
    err.textContent = "";
    const label = el<HTMLInputElement>("issue-label").value;
    api<{ id: string; token: string; url: string }>("/api/capture-policy/tokens", {
      method: "POST",
      body: JSON.stringify({ label }),
    })
      .then(({ url }) => {
        el("issue-url").textContent = url;
        el("qr").hidden = true;
        el<HTMLButtonElement>("show-qr").textContent = "Show QR";
        el("issue-result").hidden = false;
        el<HTMLInputElement>("issue-label").value = "";
        refresh();
      })
      .catch((e: unknown) => {
        err.textContent = `Issue failed: ${String(e)}`;
      });
  });

  el<HTMLButtonElement>("show-qr").addEventListener("click", () => {
    const box = el("qr");
    const btn = el<HTMLButtonElement>("show-qr");
    if (box.hidden) {
      showQr(el("issue-url").textContent ?? "");
      btn.textContent = "Hide QR";
    } else {
      box.hidden = true;
      btn.textContent = "Show QR";
    }
  });

  el<HTMLButtonElement>("copy-url").addEventListener("click", () => {
    const btn = el<HTMLButtonElement>("copy-url");
    const url = el("issue-url").textContent ?? "";
    void navigator.clipboard?.writeText(url).then(
      () => { btn.textContent = "Copied"; },
      () => { btn.textContent = "Copy failed"; },
    );
  });
};

main();
