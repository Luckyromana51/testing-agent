const $ = (id) => document.getElementById(id);

function show(s) {
  $("steps").value = s.steps.join("\n");
  $("state").textContent = s.recording ? `Recording: ${s.steps.length} steps` : `Not recording (${s.steps.length} steps)`;
  $("rec").textContent = s.recording ? "Stop" : "Record";
  $("rec").className = s.recording ? "stop" : "main";
}

const load = () => chrome.storage.local.get({ recording: false, steps: [] }, show);

$("rec").addEventListener("click", () =>
  chrome.storage.local.get({ recording: false, steps: [] }, (s) => chrome.storage.local.set({ recording: !s.recording }, load)),
);
$("clear").addEventListener("click", () => chrome.storage.local.set({ steps: [] }, load));
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("steps").value);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});
// Edits in the box are kept.
$("steps").addEventListener("input", () => chrome.storage.local.set({ steps: $("steps").value.split("\n").filter((l) => l.trim()) }));
chrome.storage.onChanged.addListener(load);
load();
