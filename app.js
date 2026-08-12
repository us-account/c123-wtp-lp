(() => {
  "use strict";

  const LOCAL_WTP_MODE = false;
  const WTP_ENDPOINT = "https://script.google.com/macros/s/AKfycby-joaFmI5NjwVfQIX23dJaShtM4C9TtxbF0W7oan19H0eWN3z_-fyNfeehv8vEDX48/exec";
  const CONTACT_EMAIL = "support@ustoolstudio.com";
  const CONSENT_VERSION = "v1";
  const SESSION_ID_KEY = "c123_wtp_session_id";
  const QUALIFIED_KEY = "c123_wtp_qualified_view_sent";

  const EVENT_NAMES = Object.freeze({
    pageView: "wtp_page_view",
    qualifiedView: "wtp_qualified_view",
    priceCtaClick: "wtp_price_cta_click",
    intentSubmit: "wtp_intent_submit",
  });
  const ALLOWED_EVENTS = new Set(Object.values(EVENT_NAMES));
  const mockEvents = [];
  const memorySession = Object.create(null);

  function randomSessionId() {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }

  function getSessionValue(key) {
    if (typeof globalThis.sessionStorage === "undefined") return memorySession[key] || null;
    try {
      return globalThis.sessionStorage.getItem(key);
    } catch {
      return memorySession[key] || null;
    }
  }

  function setSessionValue(key, value) {
    memorySession[key] = value;
    if (typeof globalThis.sessionStorage === "undefined") return;
    try {
      globalThis.sessionStorage.setItem(key, value);
    } catch {
      // Storage can be disabled. The current document still uses the in-memory fallback.
    }
  }

  let sessionId = getSessionValue(SESSION_ID_KEY);
  if (!sessionId) {
    sessionId = randomSessionId();
    setSessionValue(SESSION_ID_KEY, sessionId);
  }
  let qualifiedViewSent = getSessionValue(QUALIFIED_KEY) === "1";

  function queryValue(name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|&)${escapedName}=([^&]*)`).exec(globalThis.location?.search?.slice(1) || "");
    if (!match) return "";
    try {
      return decodeURIComponent(match[1].replace(/\+/g, " "));
    } catch {
      return "";
    }
  }

  const campaign = Object.freeze({
    utm_source: queryValue("utm_source"),
    utm_medium: queryValue("utm_medium"),
    utm_campaign: queryValue("utm_campaign"),
  });

  function eventEnvelope(eventName) {
    return {
      event_name: eventName,
      session_id: sessionId,
      ...campaign,
    };
  }

  function localMockTransport(payload) {
    mockEvents.push(Object.freeze({ ...payload }));
    document.documentElement.dataset.wtpMockEvents = mockEvents.map((item) => item.event_name).join(",");
  }

  async function endpointTransport(payload) {
    if (LOCAL_WTP_MODE || !WTP_ENDPOINT) return false;
    await fetch(WTP_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      mode: "no-cors",
      credentials: "omit",
      keepalive: true,
      redirect: "follow",
    });
    return true;
  }

  function track(eventName, intentFields = null) {
    if (!ALLOWED_EVENTS.has(eventName)) return;
    const payload = intentFields
      ? { ...eventEnvelope(eventName), ...intentFields }
      : eventEnvelope(eventName);

    if (LOCAL_WTP_MODE) {
      localMockTransport(payload);
      return;
    }
    void endpointTransport(payload);
  }

  track(EVENT_NAMES.pageView);

  const qualificationForm = document.querySelector("#qualification-form");
  const qualificationStatus = document.querySelector("#qualification-status");

  function qualificationChanged() {
    const a = qualificationForm.elements.namedItem("qualified-a").value;
    const b = qualificationForm.elements.namedItem("qualified-b").value;
    const isQualified = a === "yes" || b === "yes";

    if (isQualified) {
      qualificationStatus.textContent = "対象条件に該当します。ご回答ありがとうございます。";
      qualificationStatus.dataset.state = "qualified";
      if (!qualifiedViewSent) {
        qualifiedViewSent = true;
        setSessionValue(QUALIFIED_KEY, "1");
        track(EVENT_NAMES.qualifiedView, {
          saved_count_bucket: a === "yes" ? "50-99" : "0-49",
          multi_list_long_term: b === "yes" ? "YES" : "NO",
        });
      }
      return;
    }

    if (a && b) {
      qualificationStatus.textContent = "今回は対象条件に該当しません。ご回答ありがとうございます。";
      qualificationStatus.dataset.state = "not-qualified";
    } else {
      qualificationStatus.textContent = "A・Bの両方に回答してください。";
      delete qualificationStatus.dataset.state;
    }
  }

  qualificationForm.addEventListener("change", qualificationChanged);

  const dialog = document.querySelector("#intent-dialog");
  const form = document.querySelector("#intent-form");
  const success = document.querySelector("#form-success");
  const closeButton = document.querySelector(".dialog-close");
  const doneButton = document.querySelector(".dialog-done");
  const openButtons = document.querySelectorAll(".js-open-intent");

  function resetDialog() {
    form.hidden = false;
    success.hidden = true;
    form.reset();
  }

  function openDialog() {
    resetDialog();
    dialog.showModal();
  }

  openButtons.forEach((button) => {
    button.addEventListener("click", () => {
      track(EVENT_NAMES.priceCtaClick);
      openDialog();
    });
  });

  closeButton.addEventListener("click", () => dialog.close());
  doneButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const honeypot = form.elements.namedItem("company");
    if (honeypot.value) {
      form.reset();
      return;
    }

    if (LOCAL_WTP_MODE || !WTP_ENDPOINT) {
      track(EVENT_NAMES.intentSubmit);
    } else {
      const formData = new FormData(form);
      track(EVENT_NAMES.intentSubmit, {
        email: String(formData.get("email") || ""),
        saved_count_bucket: String(formData.get("saved_count_bucket") || ""),
        multi_list_long_term: String(formData.get("multi_list_long_term") || ""),
        issue_experience: String(formData.get("issue_experience") || ""),
        consent_version: CONSENT_VERSION,
        consent: "YES",
        honeypot: String(formData.get("company") || ""),
      });
    }

    form.reset();
    form.hidden = true;
    success.hidden = false;
    doneButton.focus();
  });

  Object.defineProperty(window, "C123_WTP_LOCAL", {
    value: Object.freeze({
      mode: LOCAL_WTP_MODE,
      endpointConfigured: Boolean(WTP_ENDPOINT),
      contactConfigured: CONTACT_EMAIL === "support@ustoolstudio.com",
      events: EVENT_NAMES,
      getMockEvents: () => mockEvents.map((item) => ({ ...item })),
      getSessionId: () => sessionId,
    }),
    writable: false,
    configurable: false,
  });
})();
