const DEFAULT_Y_THRESHOLD = 14;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function boundsFromNumbers(x1, y1, x2, y2) {
  return {
    xMin: Math.min(x1, x2),
    yMin: Math.min(y1, y2),
    xMax: Math.max(x1, x2),
    yMax: Math.max(y1, y2),
  };
}

export function boxBounds(box) {
  if (!Array.isArray(box)) return null;

  if (box.length >= 4 && box.slice(0, 4).every(isFiniteNumber)) {
    return boundsFromNumbers(box[0], box[1], box[2], box[3]);
  }

  if (!box.length) return null;

  const xs = [];
  const ys = [];
  for (const point of box) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const [x, y] = point;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    xs.push(x);
    ys.push(y);
  }

  return {
    xMin: Math.min(...xs),
    yMin: Math.min(...ys),
    xMax: Math.max(...xs),
    yMax: Math.max(...ys),
  };
}

export function boxCenter(box) {
  const bounds = boxBounds(box);
  if (!bounds) return null;
  return {
    x: (bounds.xMin + bounds.xMax) / 2,
    y: (bounds.yMin + bounds.yMax) / 2,
  };
}

export function normalizeOcrBoxes(boxes = []) {
  if (!Array.isArray(boxes)) return [];

  return boxes.flatMap((item, index) => {
    const text = item?.text;
    if (typeof text !== 'string' || !text.trim()) return [];

    const bounds = boxBounds(item?.box);
    if (!bounds) return [];

    const confidence = Number(item?.confidence);
    const width = bounds.xMax - bounds.xMin;
    const height = bounds.yMax - bounds.yMin;

    return [{
      text,
      box: item.box,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      index,
      ...bounds,
      xMid: bounds.xMin + width / 2,
      yMid: bounds.yMin + height / 2,
      width,
      height,
    }];
  });
}

function geometryForBox(item, fallbackIndex) {
  if (
    isFiniteNumber(item?.xMin)
    && isFiniteNumber(item?.yMid)
  ) {
    return {
      item,
      xMin: item.xMin,
      yMid: item.yMid,
      index: isFiniteNumber(item?.index) ? item.index : fallbackIndex,
    };
  }

  const bounds = boxBounds(item?.box);
  if (!bounds) return null;

  return {
    item,
    xMin: bounds.xMin,
    yMid: (bounds.yMin + bounds.yMax) / 2,
    index: fallbackIndex,
  };
}

function compareReadingPosition(a, b) {
  return a.yMid - b.yMid || a.xMin - b.xMin || a.index - b.index;
}

function buildRow(entries) {
  const sortedEntries = [...entries].sort((a, b) => a.xMin - b.xMin || a.index - b.index);
  const yMid = sortedEntries.reduce((sum, entry) => sum + entry.yMid, 0) / sortedEntries.length;
  return {
    yMid,
    items: sortedEntries.map((entry) => entry.item),
  };
}

export function clusterBoxesIntoRows(boxes = [], options = {}) {
  if (!Array.isArray(boxes)) return [];

  const yThreshold = options.yThreshold || DEFAULT_Y_THRESHOLD;
  const entries = boxes
    .map((item, index) => geometryForBox(item, index))
    .filter(Boolean)
    .sort(compareReadingPosition);

  const rows = [];
  let currentEntries = [];
  let currentYMid = null;

  for (const entry of entries) {
    if (currentYMid === null || Math.abs(entry.yMid - currentYMid) <= yThreshold) {
      currentEntries.push(entry);
      currentYMid = currentEntries.reduce((sum, item) => sum + item.yMid, 0) / currentEntries.length;
      continue;
    }

    rows.push(buildRow(currentEntries));
    currentEntries = [entry];
    currentYMid = entry.yMid;
  }

  if (currentEntries.length) rows.push(buildRow(currentEntries));
  return rows;
}

export function sortBoxesReadingOrder(boxes = [], options = {}) {
  return clusterBoxesIntoRows(boxes, options).flatMap((row) => row.items);
}

export function rowText(row) {
  const items = Array.isArray(row) ? row : row?.items;
  if (!Array.isArray(items)) return '';
  return items.map((item) => item?.text || '').join('');
}
