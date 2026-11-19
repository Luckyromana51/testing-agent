// GLV Step Recorder: turns what you do on a page into GLV journey steps.
// Nothing is sent anywhere: the steps stay in this browser until you copy them.
(function () {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 50);
  const quote = (s) => (/[=#.[]/.test(s.charAt(0)) || /\s=\s/.test(s) ? `"${s}"` : s);

  function labelOf(el) {
    if (!el) return "";
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return clean(l.innerText);
    }
    return clean(el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "");
  }

  function nameOf(el) {
    return clean(el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("alt") || "");
  }

  function add(step) {
    chrome.storage.local.get({ recording: false, steps: [] }, (s) => {
      if (!s.recording) return;
      const steps = s.steps;
      // Typing in the same field again replaces the earlier step.
      const last = steps[steps.length - 1];
      if (last && step.startsWith("fill ") && last.split(" = ")[0] === step.split(" = ")[0]) steps.pop();
      steps.push(step);
      chrome.storage.local.set({ steps: steps.slice(-40) });
    });
  }

  // The first page opened while recording.
  chrome.storage.local.get({ recording: false, steps: [] }, (s) => {
    if (s.recording && !s.steps.length) add(`open ${location.pathname}${location.search}${location.hash}`);
  });

  document.addEventListener(
    "click",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest("button, a, [role=button], [role=menuitem], [role=tab], [role=option], [role=link], summary, input[type=checkbox], input[type=radio], input[type=submit], label") : null;
      if (!el) return;
      // Alt+click: check the text is on the page instead of clicking.
      if (e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        const t = clean(e.target.innerText);
        if (t) add(`see ${t}`);
        return;
      }
      if (el.matches("input[type=checkbox], input[type=radio]")) {
        add(`${el.checked ? "check" : "uncheck"} ${quote(labelOf(el) || nameOf(el))}`);
        return;
      }
      if (el.matches("label")) return; // its field records the change
      const name = nameOf(el);
      if (name) add(`click ${quote(name)}`);
    },
    true,
  );

  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      if (el.matches("input[type=checkbox], input[type=radio], input[type=file], input[type=hidden]")) return;
      const label = labelOf(el);
      if (!label) return;
      if (el instanceof HTMLSelectElement) {
        add(`select ${quote(label)} = ${clean(el.options[el.selectedIndex]?.text)}`);
        return;
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        let v = el.value;
        if (el.type === "password") v = "{{password}}";
        else if (/one-time-code/.test(el.autocomplete) || /otp|2fa|totp/i.test(el.name)) v = "{{code}}";
        add(`fill ${quote(label)} = ${v.slice(0, 200)}`);
      }
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.target.form) add("press Enter");
    },
    true,
  );
})();
