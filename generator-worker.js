"use strict";

self.onmessage = event => {
  const data = event.data || {};
  if (data.type !== "generate") return;

  try {
    const puzzle = generateCrossword(data.words || [], data.options || {});
    if (!puzzle) {
      self.postMessage({
        type: "error",
        message: "Não consegui montar uma grade válida nesta tentativa. Tente gerar outra cruzada."
      });
      return;
    }
    self.postMessage({ type: "result", puzzle });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
};

function generateCrossword(rawWords, options) {
  const targetWords = Math.max(24, Number(options.targetWords) || 30);
  const requestedMin = Math.max(20, Number(options.minWords) || 28);
  const budgetMs = Math.max(5000, Number(options.timeBudgetMs) || 16000);
  const seed = Number(options.seed) || Date.now();
  const deadline = performance.now() + budgetMs;
  const words = normalizeWords(rawWords).filter(w => w.resposta.length >= 3 && w.resposta.length <= 15);

  if (words.length < requestedMin) {
    throw new Error(`O banco possui apenas ${words.length} respostas utilizáveis entre 3 e 15 letras.`);
  }

  const letterFrequency = buildLetterFrequency(words);
  const plans = [
    { size: 15, attempts: 13 },
    { size: 17, attempts: 16 },
    { size: 19, attempts: 10 }
  ];

  let best = null;
  let attemptNumber = 0;

  for (const plan of plans) {
    for (let local = 0; local < plan.attempts; local++) {
      if (performance.now() >= deadline) break;
      attemptNumber++;
      const rng = mulberry32(seed + attemptNumber * 104729 + plan.size * 8191);
      const candidate = buildAttempt(words, letterFrequency, plan.size, targetWords, rng, deadline, attemptNumber);

      if (candidate && validateCandidate(candidate)) {
        if (!best || compareCandidates(candidate, best) > 0) best = candidate;
        postProgress(formatProgress(attemptNumber, candidate));
        if (isExcellent(candidate, targetWords)) return buildPuzzle(candidate);
      }
    }

    if (best?.placements.length >= targetWords && best.orientationDiff <= 2) {
      return buildPuzzle(best);
    }
  }

  if (best?.placements.length >= Math.min(requestedMin, targetWords)) return buildPuzzle(best);
  if (best?.placements.length >= 20) return buildPuzzle(best);
  return null;
}

function normalizeWords(rawWords) {
  const result = [];
  const seen = new Set();
  for (const raw of rawWords) {
    if (raw?.ativo === false) continue;
    const resposta = normalizeAnswer(raw?.resposta || raw?.exibicao || "");
    const dica = String(raw?.dica || "").trim();
    const exibicao = String(raw?.exibicao || resposta).trim();
    if (resposta.length < 3 || !dica || seen.has(resposta)) continue;
    seen.add(resposta);
    result.push({ id: raw?.id ?? result.length + 1, resposta, exibicao, dica });
  }
  return result;
}

function normalizeAnswer(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

function buildLetterFrequency(words) {
  const frequency = new Map();
  for (const word of words) {
    for (const letter of new Set(word.resposta)) {
      frequency.set(letter, (frequency.get(letter) || 0) + 1);
    }
  }
  return frequency;
}

function createState(size) {
  return {
    size,
    grid: Array(size * size).fill(""),
    dirs: new Uint8Array(size * size),
    memberships: Array.from({ length: size * size }, () => []),
    letterCells: new Map(),
    placements: [],
    used: new Set(),
    acrossCount: 0,
    downCount: 0,
    bounds: null
  };
}

function buildAttempt(words, letterFrequency, size, targetWords, rng, deadline, attemptNumber) {
  const state = createState(size);
  const seedWord = chooseSeedWord(words, letterFrequency, size, rng);
  if (!seedWord) return finalizeCandidate(state);

  const seedDirection = attemptNumber % 2 === 0 ? "across" : "down";
  const center = Math.floor(size / 2);
  const start = centeredStart(seedWord.resposta.length, size, seedDirection, center);
  placeWord(state, seedWord, start.row, start.col, seedDirection);

  while (state.placements.length < targetWords && performance.now() < deadline) {
    const candidates = collectTopCandidates(state, words, letterFrequency, rng, deadline);
    if (!candidates.length) break;
    const poolSize = Math.min(9, candidates.length);
    const chosen = candidates[weightedTopIndex(poolSize, rng)];
    placeWord(state, chosen.word, chosen.row, chosen.col, chosen.direction);
  }

  return finalizeCandidate(state);
}

function chooseSeedWord(words, frequency, size, rng) {
  const candidates = words
    .filter(w => w.resposta.length >= 6 && w.resposta.length <= Math.min(12, size))
    .map(word => ({ word, score: seedScore(word, frequency) + rng() * 4 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(90, words.length));

  if (!candidates.length) return words.find(w => w.resposta.length <= size) || null;
  return candidates[Math.floor(rng() * Math.min(16, candidates.length))].word;
}

function collectTopCandidates(state, words, frequency, rng, deadline) {
  const remaining = words.filter(w => !state.used.has(w.resposta) && w.resposta.length <= state.size);
  shuffleInPlace(remaining, rng);
  const top = [];
  const scanLimit = Math.min(remaining.length, 760);

  for (let wi = 0; wi < scanLimit; wi++) {
    if (performance.now() >= deadline) break;
    const word = remaining[wi];
    const answer = word.resposta;
    const seenPlacements = new Set();

    for (let pos = 0; pos < answer.length; pos++) {
      const anchors = state.letterCells.get(answer[pos]);
      if (!anchors?.length) continue;

      for (const cellIndex of anchors) {
        const occupiedDirs = state.dirs[cellIndex];
        const anchorRow = Math.floor(cellIndex / state.size);
        const anchorCol = cellIndex % state.size;
        const directions = [];
        if ((occupiedDirs & 1) === 0) directions.push("across");
        if ((occupiedDirs & 2) === 0) directions.push("down");

        for (const direction of directions) {
          const { dr, dc } = directionVector(direction);
          const row = anchorRow - dr * pos;
          const col = anchorCol - dc * pos;
          const key = `${row},${col},${direction}`;
          if (seenPlacements.has(key)) continue;
          seenPlacements.add(key);

          const evaluated = evaluatePlacement(state, word, row, col, direction, frequency, rng);
          if (!evaluated) continue;
          insertTop(top, { ...evaluated, word, row, col, direction }, 42);
        }
      }
    }
  }
  return top;
}

function evaluatePlacement(state, word, row, col, direction, frequency, rng) {
  const answer = word.resposta;
  const { dr, dc, bit } = directionVector(direction);
  const endRow = row + dr * (answer.length - 1);
  const endCol = col + dc * (answer.length - 1);
  if (!inside(state.size, row, col) || !inside(state.size, endRow, endCol)) return null;

  const beforeRow = row - dr;
  const beforeCol = col - dc;
  const afterRow = endRow + dr;
  const afterCol = endCol + dc;

  if (inside(state.size, beforeRow, beforeCol) && state.grid[indexOf(state.size, beforeRow, beforeCol)]) return null;
  if (inside(state.size, afterRow, afterCol) && state.grid[indexOf(state.size, afterRow, afterCol)]) return null;

  let crossings = 0;
  let newCells = 0;
  let futureValue = 0;

  for (let i = 0; i < answer.length; i++) {
    const r = row + dr * i;
    const c = col + dc * i;
    const index = indexOf(state.size, r, c);
    const current = state.grid[index];

    if (current) {
      if (current !== answer[i]) return null;
      if ((state.dirs[index] & bit) !== 0) return null;
      crossings++;
      continue;
    }

    newCells++;
    const sideNeighbors = direction === "across"
      ? [[r - 1, c], [r + 1, c]]
      : [[r, c - 1], [r, c + 1]];

    for (const [nr, nc] of sideNeighbors) {
      if (!inside(state.size, nr, nc)) continue;
      if (state.grid[indexOf(state.size, nr, nc)]) return null;
    }

    futureValue += Math.log1p(frequency.get(answer[i]) || 0);
  }

  if (crossings < 1 || newCells < 1) return null;

  const oldArea = boundsArea(state.bounds);
  const newBounds = expandBounds(state.bounds, row, col, endRow, endCol);
  const areaGrowth = Math.max(0, boundsArea(newBounds) - oldArea);
  const oldDiff = Math.abs(state.acrossCount - state.downCount);
  const nextAcross = state.acrossCount + (direction === "across" ? 1 : 0);
  const nextDown = state.downCount + (direction === "down" ? 1 : 0);
  const balanceGain = oldDiff - Math.abs(nextAcross - nextDown);

  let score = crossings * 105 + Math.min(crossings, 4) * 14 + balanceGain * 44;
  score += futureValue * 0.65 + Math.min(answer.length, 10) * 1.8;
  score -= areaGrowth * 1.15 + newCells * 0.18;
  if (crossings >= 2) score += 55;
  if (crossings >= 3) score += 50;

  if (state.acrossCount > state.downCount + 1 && direction === "down") score += 75;
  if (state.downCount > state.acrossCount + 1 && direction === "across") score += 75;
  if (state.acrossCount > state.downCount + 2 && direction === "across") score -= 110;
  if (state.downCount > state.acrossCount + 2 && direction === "down") score -= 110;

  score += rng() * 10;
  return { score, crossings, newCells };
}

function placeWord(state, word, row, col, direction) {
  const answer = word.resposta;
  const { dr, dc, bit } = directionVector(direction);
  const slotId = `S${state.placements.length}`;
  const cells = [];

  for (let i = 0; i < answer.length; i++) {
    const r = row + dr * i;
    const c = col + dc * i;
    const index = indexOf(state.size, r, c);

    if (!state.grid[index]) {
      state.grid[index] = answer[i];
      if (!state.letterCells.has(answer[i])) state.letterCells.set(answer[i], []);
      state.letterCells.get(answer[i]).push(index);
    }

    state.dirs[index] |= bit;
    state.memberships[index].push(slotId);
    cells.push(index);
  }

  state.placements.push({ id: slotId, row, col, direction, cells, word });
  if (direction === "across") state.acrossCount++;
  else state.downCount++;

  const endRow = row + dr * (answer.length - 1);
  const endCol = col + dc * (answer.length - 1);
  state.bounds = expandBounds(state.bounds, row, col, endRow, endCol);
  state.used.add(answer);
}

function finalizeCandidate(state) {
  let occupied = 0;
  let crossings = 0;
  let totalLetters = 0;
  let wordsWithTwoOrMoreCrossings = 0;
  let wordsWithOneCrossing = 0;

  for (let i = 0; i < state.grid.length; i++) {
    if (state.grid[i]) occupied++;
    if (state.dirs[i] === 3) crossings++;
  }

  for (const placement of state.placements) {
    totalLetters += placement.cells.length;
    const wordCrossings = placement.cells.reduce((n, i) => n + (state.dirs[i] === 3 ? 1 : 0), 0);
    if (wordCrossings >= 2) wordsWithTwoOrMoreCrossings++;
    else if (wordCrossings === 1) wordsWithOneCrossing++;
  }

  const finalRows = state.bounds ? state.bounds.maxRow - state.bounds.minRow + 1 : state.size;
  const finalCols = state.bounds ? state.bounds.maxCol - state.bounds.minCol + 1 : state.size;
  const finalArea = Math.max(1, finalRows * finalCols);
  const compactness = occupied / finalArea;
  const checkedRatio = totalLetters ? (crossings * 2) / totalLetters : 0;
  const orientationDiff = Math.abs(state.acrossCount - state.downCount);
  const blackRatio = 1 - occupied / finalArea;
  const aspectRatio = Math.max(finalRows, finalCols) / Math.max(1, Math.min(finalRows, finalCols));

  return {
    ...state,
    occupied,
    crossings,
    compactness,
    checkedRatio,
    orientationDiff,
    blackRatio,
    aspectRatio,
    finalRows,
    finalCols,
    wordsWithTwoOrMoreCrossings,
    wordsWithOneCrossing
  };
}

function compareCandidates(a, b) {
  if (a.placements.length !== b.placements.length) return a.placements.length - b.placements.length;
  if (a.orientationDiff !== b.orientationDiff) return b.orientationDiff - a.orientationDiff;
  if (a.wordsWithTwoOrMoreCrossings !== b.wordsWithTwoOrMoreCrossings) return a.wordsWithTwoOrMoreCrossings - b.wordsWithTwoOrMoreCrossings;
  if (Math.abs(a.checkedRatio - b.checkedRatio) > 0.01) return a.checkedRatio - b.checkedRatio;
  if (a.crossings !== b.crossings) return a.crossings - b.crossings;
  if (Math.abs(a.aspectRatio - b.aspectRatio) > 0.08) return b.aspectRatio - a.aspectRatio;
  return a.compactness - b.compactness;
}

function isExcellent(candidate, targetWords) {
  return candidate.placements.length >= targetWords
    && candidate.orientationDiff <= 2
    && candidate.checkedRatio >= 0.32
    && candidate.aspectRatio <= 1.45;
}

function validateCandidate(candidate) {
  if (!candidate?.placements?.length) return false;
  const expected = new Set(candidate.placements.map(p => `${p.direction}:${p.cells[0]}:${p.cells.length}`));

  for (const direction of ["across", "down"]) {
    const { dr, dc } = directionVector(direction);
    for (let r = 0; r < candidate.size; r++) {
      for (let c = 0; c < candidate.size; c++) {
        const first = indexOf(candidate.size, r, c);
        if (!candidate.grid[first]) continue;
        const pr = r - dr;
        const pc = c - dc;
        if (inside(candidate.size, pr, pc) && candidate.grid[indexOf(candidate.size, pr, pc)]) continue;

        const cells = [];
        let rr = r;
        let cc = c;
        while (inside(candidate.size, rr, cc)) {
          const index = indexOf(candidate.size, rr, cc);
          if (!candidate.grid[index]) break;
          cells.push(index);
          rr += dr;
          cc += dc;
        }

        if (cells.length < 2) continue;
        if (!expected.has(`${direction}:${cells[0]}:${cells.length}`)) return false;
      }
    }
  }
  return true;
}

function buildPuzzle(candidate) {
  const { size, grid, memberships, placements, bounds } = candidate;
  if (!bounds) return null;

  const minRow = bounds.minRow;
  const maxRow = bounds.maxRow;
  const minCol = bounds.minCol;
  const maxCol = bounds.maxCol;
  const rows = maxRow - minRow + 1;
  const cols = maxCol - minCol + 1;
  const cells = [];
  const oldToNew = new Map();

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      const oldIndex = indexOf(size, r, c);
      const newRow = r - minRow;
      const newCol = c - minCol;
      const newIndex = newRow * cols + newCol;
      oldToNew.set(oldIndex, newIndex);
      const solution = grid[oldIndex] || "";
      cells.push({
        row: newRow,
        col: newCol,
        block: !solution,
        solution,
        slotIds: solution ? [...memberships[oldIndex]] : []
      });
    }
  }

  const remappedPlacements = placements.map(placement => ({
    ...placement,
    row: placement.row - minRow,
    col: placement.col - minCol,
    cells: placement.cells.map(oldIndex => oldToNew.get(oldIndex))
  }));

  const startMap = new Map();
  for (const placement of remappedPlacements) {
    const start = placement.cells[0];
    if (!startMap.has(start)) startMap.set(start, null);
  }
  [...startMap.keys()].sort((a, b) => a - b).forEach((cellIndex, i) => startMap.set(cellIndex, i + 1));

  const slots = remappedPlacements.map(placement => ({
    id: placement.id,
    number: startMap.get(placement.cells[0]),
    direction: placement.direction,
    length: placement.word.resposta.length,
    cells: [...placement.cells],
    word: {
      id: placement.word.id,
      resposta: placement.word.resposta,
      exibicao: placement.word.exibicao,
      dica: placement.word.dica
    }
  }));

  slots.sort((a, b) =>
    a.number !== b.number
      ? a.number - b.number
      : (a.direction === "across" ? -1 : 1)
  );

  const finalArea = rows * cols;
  const blackRatio = 1 - candidate.occupied / Math.max(1, finalArea);

  return {
    rows,
    cols,
    cells,
    slots,
    blackRatio,
    stats: {
      across: candidate.acrossCount,
      down: candidate.downCount,
      crossings: candidate.crossings,
      checkedRatio: candidate.checkedRatio,
      compactness: candidate.compactness,
      workspace: `${size}x${size}`,
      finalSize: `${cols}x${rows}`
    }
  };
}

function seedScore(word, frequency) {
  let score = word.resposta.length * 0.35;
  for (const letter of new Set(word.resposta)) score += Math.log1p(frequency.get(letter) || 0);
  return score;
}

function centeredStart(length, size, direction, center) {
  return direction === "across"
    ? { row: center, col: Math.max(0, Math.floor((size - length) / 2)) }
    : { row: Math.max(0, Math.floor((size - length) / 2)), col: center };
}

function directionVector(direction) {
  return direction === "across" ? { dr: 0, dc: 1, bit: 1 } : { dr: 1, dc: 0, bit: 2 };
}

function inside(size, row, col) {
  return row >= 0 && row < size && col >= 0 && col < size;
}

function indexOf(size, row, col) {
  return row * size + col;
}

function expandBounds(bounds, row, col, endRow, endCol) {
  const minRow = Math.min(row, endRow);
  const maxRow = Math.max(row, endRow);
  const minCol = Math.min(col, endCol);
  const maxCol = Math.max(col, endCol);
  if (!bounds) return { minRow, maxRow, minCol, maxCol };
  return {
    minRow: Math.min(bounds.minRow, minRow),
    maxRow: Math.max(bounds.maxRow, maxRow),
    minCol: Math.min(bounds.minCol, minCol),
    maxCol: Math.max(bounds.maxCol, maxCol)
  };
}

function boundsArea(bounds) {
  return bounds
    ? (bounds.maxRow - bounds.minRow + 1) * (bounds.maxCol - bounds.minCol + 1)
    : 0;
}

function insertTop(list, candidate, limit) {
  let index = 0;
  while (index < list.length && list[index].score >= candidate.score) index++;
  list.splice(index, 0, candidate);
  if (list.length > limit) list.length = limit;
}

function weightedTopIndex(length, rng) {
  if (length <= 1) return 0;
  const weights = Array.from({ length }, (_, i) => (length - i) ** 1.7);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return 0;
}

function shuffleInPlace(array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function formatProgress(attemptNumber, candidate) {
  return `Tentativa ${attemptNumber}: ${candidate.placements.length} palavras (${candidate.acrossCount}H/${candidate.downCount}V), ${candidate.crossings} cruzamentos; área útil ${candidate.finalCols}x${candidate.finalRows}.`;
}

function postProgress(message) {
  self.postMessage({ type: "progress", message });
}
