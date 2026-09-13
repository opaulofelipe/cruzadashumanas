const JSON_FILES = [
  "palavras-2.json",
  "palavras-3.json",
  "palavras-4.json",
  "palavras-5.json",
  "palavras-6.json",
  "palavras-7.json",
  "palavras-8-10.json",
  "palavras-11mais.json"
];

const DATA_BASES = ["./dados/", "./"];
const STORAGE_KEY = "cruzadas-historicas-partida-v2";
const STATE_VERSION = 2;

const els = {
  loadingView: document.querySelector("#loading-view"),
  loadingTitle: document.querySelector("#loading-title"),
  loadingDetail: document.querySelector("#loading-detail"),
  gameView: document.querySelector("#game-view"),
  errorView: document.querySelector("#error-view"),
  errorMessage: document.querySelector("#error-message"),
  retry: document.querySelector("#retry"),
  newGame: document.querySelector("#new-game"),
  boardWrap: document.querySelector("#board-wrap"),
  board: document.querySelector("#board"),
  progress: document.querySelector("#progress"),
  wordCount: document.querySelector("#word-count"),
  blackRate: document.querySelector("#black-rate"),
  activeClueLabel: document.querySelector("#active-clue-label"),
  activeClueText: document.querySelector("#active-clue-text"),
  previousClue: document.querySelector("#previous-clue"),
  nextClue: document.querySelector("#next-clue"),
  virtualKeyboard: document.querySelector("#virtual-keyboard"),
  acrossClues: document.querySelector("#across-clues"),
  downClues: document.querySelector("#down-clues"),
  check: document.querySelector("#check"),
  clearWord: document.querySelector("#clear-word"),
  revealWord: document.querySelector("#reveal-word"),
  completeDialog: document.querySelector("#complete-dialog"),
  completeSummary: document.querySelector("#complete-summary"),
  completeNew: document.querySelector("#complete-new")
};

let bank = [];
let worker = null;
let puzzle = null;
let cellEls = [];
let userLetters = [];
let selectedCell = null;
let activeSlotId = null;
let checks = new Map();
let generating = false;

init();

async function init() {
  bindEvents();

  try {
    bank = await loadBank();
    if (bank.length < 30) throw new Error("O banco possui menos de 30 palavras válidas.");

    if (!restoreGame()) {
      await generatePuzzle();
    }
  } catch (error) {
    showError(error.message || String(error));
  }
}

function bindEvents() {
  els.newGame.addEventListener("click", startNewPuzzle);
  els.retry.addEventListener("click", () => generatePuzzle());
  els.completeNew.addEventListener("click", () => {
    els.completeDialog.close();
    startNewPuzzle();
  });

  els.check.addEventListener("click", checkPuzzle);
  els.clearWord.addEventListener("click", clearActiveWord);
  els.revealWord.addEventListener("click", revealActiveWord);
  els.previousClue?.addEventListener("click", () => navigateClue(-1));
  els.nextClue?.addEventListener("click", () => navigateClue(1));

  els.virtualKeyboard?.addEventListener("pointerdown", event => {
    const button = event.target.closest("button[data-key]");
    if (!button || !puzzle || generating) return;
    event.preventDefault();
    const key = button.dataset.key;
    if (key === "BACKSPACE") handleBackspace();
    else if (/^[A-Z]$/.test(key)) enterLetter(key);
  });

  document.addEventListener("keydown", event => {
    if (!puzzle || generating) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === "Backspace") {
      event.preventDefault();
      handleBackspace();
      return;
    }
    if (event.key === "ArrowRight") { event.preventDefault(); moveSelection(0, 1); return; }
    if (event.key === "ArrowLeft") { event.preventDefault(); moveSelection(0, -1); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(1, 0); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(-1, 0); return; }

    if (/^[a-zA-ZÀ-ÿ]$/.test(event.key)) {
      const letter = normalizeAnswer(event.key);
      if (letter) {
        event.preventDefault();
        enterLetter(letter);
      }
    }
  });
}

async function loadBank() {
  setLoading("Carregando banco de palavras…", "Lendo os 8 arquivos JSON.");
  const all = [];

  for (let i = 0; i < JSON_FILES.length; i++) {
    const filename = JSON_FILES[i];
    setLoading("Carregando banco de palavras…", `${i + 1} de ${JSON_FILES.length}: ${filename}`);
    const payload = await fetchJsonWithFallback(filename);
    const entries = Array.isArray(payload) ? payload : payload.perguntas;
    if (!Array.isArray(entries)) throw new Error(`${filename} não possui uma lista "perguntas" válida.`);

    for (const entry of entries) {
      const resposta = normalizeAnswer(entry.resposta || entry.exibicao || "");
      const dica = String(entry.dica || "").trim();
      const exibicao = String(entry.exibicao || resposta).trim();
      if (entry.ativo === false || resposta.length < 2 || !dica) continue;
      all.push({ id: entry.id ?? `${filename}-${all.length}`, resposta, exibicao, dica, ativo: true });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const item of all) {
    if (seen.has(item.resposta)) continue;
    seen.add(item.resposta);
    deduped.push(item);
  }
  return deduped;
}

async function fetchJsonWithFallback(filename) {
  let lastError = null;
  for (const base of DATA_BASES) {
    try {
      const response = await fetch(`${base}${filename}?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Não consegui carregar ${filename}. ${lastError?.message || ""}`);
}

function startNewPuzzle() {
  clearSavedGame();
  if (els.completeDialog.open) els.completeDialog.close();
  generatePuzzle();
}

async function generatePuzzle() {
  if (generating || !bank.length) return;

  generating = true;
  terminateWorker();
  puzzle = null;
  userLetters = [];
  selectedCell = null;
  activeSlotId = null;
  checks.clear();

  els.gameView.hidden = true;
  els.errorView.hidden = true;
  els.loadingView.hidden = false;
  setLoading("Montando uma grade densa…", "Buscando uma grade com no mínimo 30 respostas e poucos blocos pretos.");

  worker = new Worker("./generator-worker.js?v=3");

  worker.onmessage = event => {
    const data = event.data || {};
    if (data.type === "progress") {
      setLoading("Montando uma grade densa…", data.message || "Tentando combinações…");
      return;
    }
    if (data.type === "result") {
      generating = false;
      puzzle = data.puzzle;
      terminateWorker();
      renderPuzzle({ preserveState: false });
      saveGame();
      return;
    }
    if (data.type === "error") {
      generating = false;
      terminateWorker();
      showError(data.message || "Não foi possível gerar uma cruzada.");
    }
  };

  worker.onerror = error => {
    generating = false;
    terminateWorker();
    showError(`Erro no gerador: ${error.message}`);
  };

  worker.postMessage({
    type: "generate",
    words: bank,
    options: { minWords: 30, targetWords: 30, timeBudgetMs: 14000, seed: cryptoSeed() }
  });
}

function terminateWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function renderPuzzle({ preserveState = false } = {}) {
  els.loadingView.hidden = true;
  els.errorView.hidden = true;
  els.gameView.hidden = false;

  const { rows, cols, cells, slots, blackRatio } = puzzle;
  cellEls = Array(rows * cols).fill(null);

  if (!preserveState) {
    userLetters = Array(rows * cols).fill("");
    checks.clear();
    selectedCell = null;
    activeSlotId = null;
  } else {
    userLetters = Array.from({ length: rows * cols }, (_, i) => userLetters[i] || "");
  }

  els.board.innerHTML = "";
  els.board.style.setProperty("--cols", cols);
  els.board.setAttribute("aria-rowcount", rows);
  els.board.setAttribute("aria-colcount", cols);

  const startNumbers = new Map();
  for (const slot of slots) {
    const first = slot.cells[0];
    if (!startNumbers.has(first)) startNumbers.set(first, slot.number);
  }

  cells.forEach((cell, index) => {
    if (cell.block) {
      const block = document.createElement("div");
      block.className = "cell black";
      block.setAttribute("aria-hidden", "true");
      els.board.appendChild(block);
      cellEls[index] = block;
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cell";
    button.dataset.index = String(index);
    button.setAttribute("role", "gridcell");
    button.setAttribute("aria-label", `Casa ${cell.row + 1}, ${cell.col + 1}`);

    const number = startNumbers.get(index);
    if (number) {
      const num = document.createElement("span");
      num.className = "cell-number";
      num.textContent = number;
      button.appendChild(num);
    }

    const letter = document.createElement("span");
    letter.className = "cell-letter";
    button.appendChild(letter);
    button.addEventListener("click", () => selectCell(index, true));
    els.board.appendChild(button);
    cellEls[index] = button;
  });

  renderClues();
  userLetters.forEach((letter, index) => { if (letter) renderCellLetter(index); });
  els.wordCount.textContent = String(slots.length);
  els.blackRate.textContent = `${Math.round(blackRatio * 100)}%`;
  updateProgress();

  const slotsOrdered = orderedSlots();
  const fallbackSlot = slotsOrdered[0];
  if (!getSlot(activeSlotId)) activeSlotId = fallbackSlot?.id ?? null;
  if (selectedCell == null || puzzle.cells[selectedCell]?.block) selectedCell = getSlot(activeSlotId)?.cells[0] ?? null;
  updateSelectionUI(false);
}

function renderClues() {
  els.acrossClues.innerHTML = "";
  els.downClues.innerHTML = "";

  for (const slot of puzzle.slots) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clue-button";
    button.dataset.slotId = slot.id;
    button.innerHTML = `<span class="clue-number">${slot.number}.</span>${escapeHtml(slot.word.dica)}`;
    button.addEventListener("click", () => selectSlot(slot.id));
    (slot.direction === "across" ? els.acrossClues : els.downClues).appendChild(button);
  }
}

function selectCell(index, toggleDirection = false) {
  if (!puzzle || puzzle.cells[index]?.block) return;
  const slotIds = puzzle.cells[index].slotIds || [];
  if (!slotIds.length) return;

  if (toggleDirection && selectedCell === index && slotIds.length > 1) {
    const currentPos = slotIds.indexOf(activeSlotId);
    activeSlotId = slotIds[(currentPos + 1) % slotIds.length];
  } else if (!slotIds.includes(activeSlotId)) {
    activeSlotId = slotIds[0];
  }

  selectedCell = index;
  updateSelectionUI();
}

function selectSlot(slotId) {
  const slot = getSlot(slotId);
  if (!slot) return;
  activeSlotId = slotId;
  if (!slot.cells.includes(selectedCell)) selectedCell = slot.cells.find(index => !userLetters[index]) ?? slot.cells[0];
  updateSelectionUI();
}

function navigateClue(delta) {
  if (!puzzle?.slots?.length) return;
  const slots = orderedSlots();
  const currentIndex = Math.max(0, slots.findIndex(slot => slot.id === activeSlotId));
  const nextSlot = slots[(currentIndex + delta + slots.length) % slots.length];
  activeSlotId = nextSlot.id;
  selectedCell = nextSlot.cells.find(index => !userLetters[index]) ?? nextSlot.cells[0];
  updateSelectionUI();
}

function orderedSlots() {
  if (!puzzle?.slots) return [];
  return [...puzzle.slots].sort((a, b) => {
    if (a.number !== b.number) return a.number - b.number;
    if (a.direction === b.direction) return 0;
    return a.direction === "across" ? -1 : 1;
  });
}

function updateSelectionUI(shouldSave = true) {
  if (!puzzle) return;
  const slot = getSlot(activeSlotId);
  const sameWord = new Set(slot?.cells || []);

  for (let i = 0; i < cellEls.length; i++) {
    const el = cellEls[i];
    if (!el || puzzle.cells[i].block) continue;
    el.classList.toggle("same-word", sameWord.has(i));
    el.classList.toggle("selected", i === selectedCell);
  }

  document.querySelectorAll(".clue-button").forEach(button => {
    button.classList.toggle("active", button.dataset.slotId === activeSlotId);
  });

  if (slot) {
    els.activeClueLabel.textContent = `${slot.direction === "across" ? "H" : "V"}${slot.number}.`;
    els.activeClueText.textContent = slot.word.dica;
    ensureSelectedCellVisible();
  }

  if (shouldSave) saveGame();
}

function ensureSelectedCellVisible() {
  if (selectedCell == null) return;
  const cell = cellEls[selectedCell];
  const scroller = els.boardWrap;
  if (!cell || !scroller || cell.classList.contains("black")) return;

  const cellRect = cell.getBoundingClientRect();
  const scrollRect = scroller.getBoundingClientRect();
  const margin = 12;
  let left = scroller.scrollLeft;
  let top = scroller.scrollTop;

  if (cellRect.left < scrollRect.left + margin) left -= (scrollRect.left + margin) - cellRect.left;
  else if (cellRect.right > scrollRect.right - margin) left += cellRect.right - (scrollRect.right - margin);

  if (cellRect.top < scrollRect.top + margin) top -= (scrollRect.top + margin) - cellRect.top;
  else if (cellRect.bottom > scrollRect.bottom - margin) top += cellRect.bottom - (scrollRect.bottom - margin);

  scroller.scrollTo({ left, top, behavior: "smooth" });
}

function enterLetter(letter) {
  if (!puzzle || selectedCell == null || !/^[A-Z]$/.test(letter)) return;
  userLetters[selectedCell] = letter;
  checks.delete(selectedCell);
  renderCellLetter(selectedCell);

  const slot = getSlot(activeSlotId);
  if (slot) {
    const pos = slot.cells.indexOf(selectedCell);
    const next = slot.cells[pos + 1];
    if (next != null) selectedCell = next;
  }

  updateSelectionUI(false);
  updateProgress();
  saveGame();
  maybeComplete();
}

function handleBackspace() {
  if (!puzzle || selectedCell == null) return;

  if (userLetters[selectedCell]) {
    userLetters[selectedCell] = "";
    checks.delete(selectedCell);
    renderCellLetter(selectedCell);
  } else {
    const slot = getSlot(activeSlotId);
    const pos = slot?.cells.indexOf(selectedCell) ?? -1;
    const previous = pos > 0 ? slot.cells[pos - 1] : null;
    if (previous != null) {
      selectedCell = previous;
      userLetters[selectedCell] = "";
      checks.delete(selectedCell);
      renderCellLetter(selectedCell);
    }
  }

  updateSelectionUI(false);
  updateProgress();
  saveGame();
}

function moveSelection(dr, dc) {
  if (!puzzle || selectedCell == null) return;
  const current = puzzle.cells[selectedCell];
  let row = current.row + dr;
  let col = current.col + dc;

  while (row >= 0 && row < puzzle.rows && col >= 0 && col < puzzle.cols) {
    const index = row * puzzle.cols + col;
    if (!puzzle.cells[index].block) { selectCell(index, false); return; }
    row += dr;
    col += dc;
  }
}

function clearActiveWord() {
  const slot = getSlot(activeSlotId);
  if (!slot) return;
  for (const index of slot.cells) {
    userLetters[index] = "";
    checks.delete(index);
    renderCellLetter(index);
  }
  selectedCell = slot.cells[0];
  updateSelectionUI(false);
  updateProgress();
  saveGame();
}

function revealActiveWord() {
  const slot = getSlot(activeSlotId);
  if (!slot || !window.confirm("Revelar esta palavra?")) return;
  slot.cells.forEach((index, i) => {
    userLetters[index] = slot.word.resposta[i];
    checks.set(index, "correct");
    renderCellLetter(index);
  });
  updateProgress();
  saveGame();
  maybeComplete();
}

function checkPuzzle() {
  if (!puzzle) return;
  for (let i = 0; i < puzzle.cells.length; i++) {
    const cell = puzzle.cells[i];
    if (cell.block || !userLetters[i]) continue;
    checks.set(i, userLetters[i] === cell.solution ? "correct" : "wrong");
    renderCellLetter(i);
  }
  saveGame();
  maybeComplete();
}

function renderCellLetter(index) {
  const el = cellEls[index];
  if (!el || puzzle.cells[index].block) return;
  const span = el.querySelector(".cell-letter");
  if (span) span.textContent = userLetters[index] || "";
  el.classList.remove("correct", "wrong");
  const status = checks.get(index);
  if (status) el.classList.add(status);
}

function updateProgress() {
  if (!puzzle) return;
  const openIndexes = puzzle.cells.map((cell, index) => ({ cell, index })).filter(item => !item.cell.block).map(item => item.index);
  const filled = openIndexes.filter(index => userLetters[index]).length;
  els.progress.textContent = `${filled} / ${openIndexes.length}`;
}

function maybeComplete() {
  if (!puzzle) return;
  const complete = puzzle.cells.every((cell, index) => cell.block || userLetters[index] === cell.solution);
  if (!complete) return;
  els.completeSummary.textContent = `${puzzle.slots.length} palavras em uma grade ${puzzle.cols}×${puzzle.rows}, com ${Math.round(puzzle.blackRatio * 100)}% de casas pretas.`;
  if (!els.completeDialog.open) els.completeDialog.showModal();
}

function getSlot(slotId) {
  return puzzle?.slots.find(slot => slot.id === slotId) || null;
}

function saveGame() {
  if (!puzzle) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: STATE_VERSION,
      puzzle,
      userLetters,
      selectedCell,
      activeSlotId,
      checks: [...checks.entries()]
    }));
  } catch (error) {
    console.warn("Não foi possível salvar a partida.", error);
  }
}

function restoreGame() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (saved?.version !== STATE_VERSION || !isValidPuzzle(saved.puzzle)) {
      clearSavedGame();
      return false;
    }

    puzzle = saved.puzzle;
    userLetters = Array.isArray(saved.userLetters) ? saved.userLetters.map(value => /^[A-Z]$/.test(value) ? value : "") : [];
    selectedCell = Number.isInteger(saved.selectedCell) ? saved.selectedCell : null;
    activeSlotId = typeof saved.activeSlotId === "string" ? saved.activeSlotId : null;
    checks = new Map(Array.isArray(saved.checks) ? saved.checks : []);
    generating = false;
    renderPuzzle({ preserveState: true });
    return true;
  } catch (error) {
    console.warn("Partida salva inválida; uma nova será criada.", error);
    clearSavedGame();
    return false;
  }
}

function isValidPuzzle(value) {
  return value && Number.isInteger(value.rows) && Number.isInteger(value.cols)
    && Array.isArray(value.cells) && value.cells.length === value.rows * value.cols
    && Array.isArray(value.slots) && value.slots.length > 0;
}

function clearSavedGame() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

function setLoading(title, detail) {
  els.loadingTitle.textContent = title;
  els.loadingDetail.textContent = detail;
}

function showError(message) {
  generating = false;
  terminateWorker();
  els.loadingView.hidden = true;
  els.gameView.hidden = true;
  els.errorView.hidden = false;
  els.errorMessage.textContent = message;
}

function normalizeAnswer(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
}

function cryptoSeed() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
