let cocoData;
let hierarchyRoots = null; // Will hold the root nodes of the hierarchy tree
let categoryNodeMap = new Map(); // Global lookup: categoryId -> Node
let currentIndex = 0;
let annotationsVisible = true;
let labelsVisible = false; // Toggle for text labels
let imageScaled = true;
let hierarchyExpandMode = 'best'; // 'collapsed', 'expanded', 'best'
let globalLineOptions = {};

// Filter State
let minConfidence = 0.0;
let nmsIoU = 1.0;

// Track selection
let selectedAnnotation = null;

// Bootstrap offcanvas instance
let detailsPanel = null;

const defaultPalette = [
  '#E41A1C', '#377EB8', '#4DAF4A', '#984EA3',
  '#FF7F00', '#FFFF33', '#A65628', '#F781BF',
  '#66C2A5', '#FC8D62', '#8DA0CB', '#E78AC3',
  '#A6D854', '#FFD92F', '#E5C494',
  '#1B9E77', '#D95F02', '#7570B3', '#E7298A',
  '#66A61E', '#E6AB02', '#A6761D',
  '#A6CEE3', '#1F78B4', '#B2DF8A', '#33A02C',
  '#FB9A99', '#E31A1C', '#FDBF6F', '#CAB2D6', '#6A3D9A'
];

const lineOptions = {}; 

function generateCategoryColors(categories, overrides = {}) {
  const options = {};
  categories.forEach((cat, idx) => {
    const defaultColor = defaultPalette[idx % defaultPalette.length];
    const override = overrides[cat.id] || {};
    const endArrows = {};
    if (cat.skeleton) {
      cat.skeleton.forEach(([i, j]) => {
        endArrows[j] = { lineEnd: 'arrow' };
      });
    }
    options[cat.id] = {
      ...override,
      color: override.color || defaultColor,
      end: override.end || endArrows
    };
  });
  return options;
}

function generateLegend(categories, lineOpts) {
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  categories.forEach(cat => {
    const color = lineOpts[cat.id]?.color || 'blue';
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.marginBottom = '4px';
    div.innerHTML = `
      <div style="width: 16px; height: 16px; background: ${color}; margin-right: 8px; border-radius: 2px;"></div>
      <span class="small text-light">${cat.name}</span>
    `;
    legend.appendChild(div);
  });
}

/**
 * Builds a tree structure from COCO categories and a flat parent-child map.
 * Also populates the global categoryNodeMap.
 */
function buildHierarchyTree(categories, hierarchyMap) {
  categoryNodeMap.clear();
  const nodeMap = new Map();

  const getNode = (name) => {
    if (!nodeMap.has(name)) {
      // Node structure now includes 'parent' for upward traversal
      nodeMap.set(name, { name: name, children: [], categoryId: null, parent: null, hasParent: false });
    }
    return nodeMap.get(name);
  };

  // Add all COCO categories to registry
  categories.forEach(cat => {
    const node = getNode(cat.name);
    node.categoryId = cat.id;
    categoryNodeMap.set(cat.id, node);
  });

  // Process Hierarchy relationships
  if (hierarchyMap) {
    Object.entries(hierarchyMap).forEach(([childName, parentName]) => {
      const childNode = getNode(childName);
      const parentNode = getNode(parentName);
      
      // Avoid duplicates
      if (!parentNode.children.includes(childNode)) {
        parentNode.children.push(childNode);
        childNode.parent = parentNode; // Link parent
      }
      
      childNode.hasParent = true;
    });
  }

  // Identify Roots
  const roots = [];
  for (const node of nodeMap.values()) {
    if (!node.hasParent) {
      roots.push(node);
    }
  }

  return roots;
}

async function loadCOCO(url, hierUrl = null, overrideLineOptions = {}) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    cocoData = await response.json();
  } catch (e) {
    alert("Failed to load JSON: " + e.message);
    return;
  }

  // --- DATA SANITIZATION ---
  if (cocoData.annotations) {
    cocoData.annotations.forEach(ann => {
      if (ann.scores && Array.isArray(ann.scores)) {
        ann.scores = ann.scores.map(x => {
          const n = Number(x);
          return isNaN(n) ? 0 : n;
        });
      }
    });
  }

  // --- HIERARCHY LOADING ---
  // We ALWAYS build a tree. If no file is provided, we build a "flat" tree (map={}).
  let hMap = {};
  if (hierUrl && hierUrl.trim() !== '') {
    try {
      const hResp = await fetch(hierUrl);
      if (hResp.ok) {
        hMap = await hResp.json();
        console.log("Hierarchy file loaded.");
      } else {
        console.warn("Hierarchy file not found. Defaulting to flat list.");
      }
    } catch (e) {
      console.warn("Failed to load hierarchy:", e.message);
    }
  }
  
  hierarchyRoots = buildHierarchyTree(cocoData.categories, hMap);
  console.log("Hierarchy Roots:", hierarchyRoots);

  cocoData.imageMap = {};
  cocoData.annotationsByImage = {};
  cocoData.images.forEach(img => {
    cocoData.imageMap[img.id] = img;
    cocoData.annotationsByImage[img.id] = [];
  });
  cocoData.annotations.forEach(ann => {
    if (cocoData.annotationsByImage[ann.image_id]) {
      cocoData.annotationsByImage[ann.image_id].push(ann);
    }
  });

  globalLineOptions = generateCategoryColors(cocoData.categories, overrideLineOptions);
  generateLegend(cocoData.categories, globalLineOptions);

  const typeSelect = document.getElementById('annotation-type');
  let detectedType = 'keypoint'; 
  const validAnn = cocoData.annotations.find(a => (a.keypoints && a.keypoints.length) || a.bbox);
  if (validAnn) {
    if (validAnn.keypoints && validAnn.keypoints.length > 0) {
      detectedType = 'keypoint';
    } else if (validAnn.bbox && validAnn.bbox.length === 4) {
      detectedType = 'bbox';
    }
  }
  if(typeSelect) typeSelect.value = detectedType;

  updateImageScale();
  showImage(0);
}

// ---- Helper Logic: Pipeline Filtering ----

/**
 * Calculates IoU (Intersection over Union) between two annotations.
 * Expects ann.bbox = [x, y, w, h]
 */
function calculateIoU(boxA, boxB) {
  const [xA, yA, wA, hA] = boxA;
  const [xB, yB, wB, hB] = boxB;

  const interX1 = Math.max(xA, xB);
  const interY1 = Math.max(yA, yB);
  const interX2 = Math.min(xA + wA, xB + wB);
  const interY2 = Math.min(yA + hA, yB + hB);

  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  
  const intersectionArea = interW * interH;
  const areaA = wA * hA;
  const areaB = wB * hB;
  
  const unionArea = areaA + areaB - intersectionArea;
  
  if (unionArea <= 0) return 0;
  return intersectionArea / unionArea;
}

/**
 * Gets the Root Category ID for an annotation.
 * If flat/no hierarchy, returns the category_id itself.
 */
function getRootId(ann) {
  let node = categoryNodeMap.get(ann.category_id);
  // Traverse up to the root
  while (node && node.parent) {
    node = node.parent;
  }
  return node ? node.categoryId : ann.category_id;
}

/**
 * Gets the Score used for filtering.
 * Uses Root Node score if scores array exists, otherwise uses assigned category score.
 */
function getFilterScore(ann) {
  // If no scores array, treat as 100% confidence so it doesn't get filtered out
  if (!ann.scores || ann.scores.length === 0) return 1.0;

  const rootId = getRootId(ann);
  
  // Return score of the root (implicit hierarchy scope)
  if (ann.scores[rootId] !== undefined) {
    return ann.scores[rootId];
  }
  
  // Fallback
  return 0.0;
}

/**
 * The Filtering Pipeline.
 * Stage 1: Confidence Filter (Gatekeeper)
 * Stage 2: NMS (Strict suppression)
 */
function getFilteredAnnotations() {
  if (!cocoData || !cocoData.images) return [];
  const imgData = cocoData.images[currentIndex];
  const rawAnns = cocoData.annotationsByImage[imgData.id] || [];

  // --- STAGE 1: CONFIDENCE FILTER ---
  let survivors = rawAnns.filter(ann => {
    const score = getFilterScore(ann);
    return score >= minConfidence;
  });

  // --- STAGE 2: NMS ---
  // If IoU slider is at 1.0, we skip NMS entirely (optimization)
  if (nmsIoU >= 1.0) {
    return survivors;
  }

  // Pre-calculate effective scores for sorting
  // We need to keep the original objects, so we map wrapper objects
  let candidates = survivors.map(ann => ({
    ann: ann,
    score: getFilterScore(ann),
    rootId: getRootId(ann),
    hasBox: (ann.bbox && ann.bbox.length === 4)
  }));

  // Sort by Score Descending
  candidates.sort((a, b) => b.score - a.score);

  const finalSet = [];
  const suppressedIndices = new Set();

  for (let i = 0; i < candidates.length; i++) {
    if (suppressedIndices.has(i)) continue;

    const current = candidates[i];
    finalSet.push(current.ann);

    // If this annotation has no box, it cannot suppress others (skip NMS logic for it)
    if (!current.hasBox) continue;

    for (let j = i + 1; j < candidates.length; j++) {
      if (suppressedIndices.has(j)) continue;
      
      const other = candidates[j];
      
      // Keypoint-only annotations (no box) are never suppressed
      if (!other.hasBox) continue;

      // NMS Scope: Root-Specific
      // Only suppress if they share the same Root
      if (current.rootId !== other.rootId) continue;

      const iou = calculateIoU(current.ann.bbox, other.ann.bbox);
      if (iou > nmsIoU) {
        suppressedIndices.add(j);
      }
    }
  }

  return finalSet;
}

window.updateFilters = function() {
  const confSlider = document.getElementById('conf-slider');
  const nmsSlider = document.getElementById('nms-slider');
  const confLabel = document.getElementById('conf-val');
  const nmsLabel = document.getElementById('nms-val');

  if (confSlider) {
    minConfidence = parseFloat(confSlider.value);
    confLabel.textContent = minConfidence.toFixed(2);
  }
  
  if (nmsSlider) {
    nmsIoU = parseFloat(nmsSlider.value);
    nmsLabel.textContent = nmsIoU.toFixed(2);
  }

  // Deselect if the selected annotation was filtered out
  const filtered = getFilteredAnnotations();
  if (selectedAnnotation && !filtered.find(a => a.id === selectedAnnotation.id)) {
    selectedAnnotation = null;
    updateDetailsPanel(null);
  }

  drawAnnotations(globalLineOptions);
}


// ---- Canvas Interaction Logic ----

window.addEventListener('load', () => {
  const canvas = document.getElementById('annotation-canvas');
  if (canvas) {
    canvas.addEventListener('mousedown', handleCanvasClick);
  }

  const storedJson = localStorage.getItem('coco_json_url');
  if (storedJson) {
    const el = document.getElementById('json-url');
    if (el) el.value = storedJson;
  }
  
  const storedHier = localStorage.getItem('coco_hierarchy_url');
  if (storedHier) {
    const el = document.getElementById('hierarchy-url');
    if (el) el.value = storedHier;
  }
});

function handleCanvasClick(e) {
  if (!cocoData || !cocoData.images) return;
  
  const canvas = document.getElementById('annotation-canvas');
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  
  const clickX = (e.clientX - rect.left) * scaleX;
  const clickY = (e.clientY - rect.top) * scaleY;

  console.log(`Click Event: (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);

  // Use the Filtered List for hit-testing
  const visibleAnns = getFilteredAnnotations();

  const candidates = [];
  // Loop reverse to find top-most first
  for (let i = visibleAnns.length - 1; i >= 0; i--) {
    const ann = visibleAnns[i];
    if (ann.bbox) {
      const [x, y, w, h] = ann.bbox;
      if (clickX >= x && clickX <= x + w && clickY >= y && clickY <= y + h) {
        candidates.push(ann);
      }
    }
  }

  console.log(`Candidates found: ${candidates.length}`, candidates.map(c => c.id));

  if (candidates.length === 0) {
    selectedAnnotation = null;
    console.log("No candidates. Deselecting.");
  } else {
    const currentIndex = selectedAnnotation ? candidates.findIndex(c => c.id === selectedAnnotation.id) : -1;
    console.log(`Current Selection ID: ${selectedAnnotation ? selectedAnnotation.id : 'null'} | Index in candidates: ${currentIndex}`);

    if (currentIndex !== -1) {
      const nextIndex = (currentIndex + 1) % candidates.length;
      selectedAnnotation = candidates[nextIndex];
      console.log(`Cycling to next index: ${nextIndex} (ID: ${selectedAnnotation.id})`);
    } else {
      selectedAnnotation = candidates[0];
      console.log(`Selecting top-most: (ID: ${selectedAnnotation.id})`);
    }
  }

  drawAnnotations(globalLineOptions);
  updateDetailsPanel(selectedAnnotation);
}

function updateDetailsPanel(ann) {
  if (!detailsPanel) {
    const el = document.getElementById('sidebarDetails');
    if (window.bootstrap) {
      detailsPanel = new bootstrap.Offcanvas(el);
    }
  }

  const contentDiv = document.getElementById('details-content');
  
  if (!ann) {
    contentDiv.innerHTML = `
      <div class="text-center text-secondary mt-5">
        <i class="bi bi-hand-index fs-1"></i>
        <p class="mt-2">Select an annotation on the image to view detailed probability scores.</p>
      </div>`;
    return;
  }

  if (detailsPanel) detailsPanel.show();

  const category = cocoData.categories.find(c => c.id === ann.category_id);
  const bestScore = (ann.scores && ann.scores[category.id] !== undefined) ? ann.scores[category.id] : null;

  let html = `
    <div class="mb-3 p-3 bg-secondary bg-opacity-10 rounded border border-secondary">
      <h6 class="text-info text-uppercase small fw-bold mb-1">Selected Annotation</h6>
      <div class="fs-4">${category.name}</div>
      ${bestScore !== null ? `<div class="text-light">Confidence: <span class="fw-bold score-highlight">${bestScore.toFixed(4)}</span></div>` : ''}
      <div class="small text-secondary mt-1">ID: ${ann.id}</div>
    </div>
  `;

  html += `<h6 class="text-secondary text-uppercase small fw-bold mb-3 border-bottom border-secondary pb-2">Class Distribution</h6>`;
  html += `<div class="d-flex flex-column gap-2">`;

  // --- PATH CALCULATION ---
  const truePathNodes = new Set();
  const bestPathNodes = new Set();
  
  // 1. Identify True Path (Upward from Assigned Category)
  let trueNode = categoryNodeMap.get(ann.category_id);
  while(trueNode) {
    truePathNodes.add(trueNode);
    trueNode = trueNode.parent;
  }

  // 2. Identify Best Path (Downward from Roots using Scores)
  // Only if scores exist
  const hasScores = (ann.scores && ann.scores.length > 0);
  
  if (hasScores) {
    const getScore = (n) => {
      if (n.categoryId === null) return -1;
      const val = ann.scores[n.categoryId];
      return (typeof val === 'number') ? val : -1;
    };

    let currentCandidates = hierarchyRoots;
    while (currentCandidates && currentCandidates.length > 0) {
      let bestNode = null;
      let maxScore = -Infinity;
      
      for (const node of currentCandidates) {
        const s = getScore(node);
        if (s > maxScore) {
          maxScore = s;
          bestNode = node;
        }
      }
      
      if (bestNode && maxScore > -1) {
        bestPathNodes.add(bestNode);
        currentCandidates = bestNode.children;
      } else {
        break; 
      }
    }
  }

  // --- RECURSIVE RENDERER ---
  const renderNode = (node) => {
    let score = (hasScores && node.categoryId !== null && ann.scores[node.categoryId] !== undefined) 
                  ? ann.scores[node.categoryId] 
                  : null;
    
    // Highlights
    const isTruePath = truePathNodes.has(node);
    const isBestPath = bestPathNodes.has(node);

    // Text Class Logic
    // Precedence: Best Path (Gold) > True Path (Cyan) > Default
    let textClass = '';
    if (isBestPath) {
      textClass = 'score-highlight'; 
    } else if (isTruePath) {
      textClass = 'text-info fw-bold';
    }

    // Score Class: Best Path gets 'score-highlight' (Gold), others 'score-normal'
    const scoreClass = isBestPath ? 'score-highlight' : 'score-normal';

    const scoreDisplay = score !== null 
      ? `<span class="${scoreClass} ms-2">${score.toFixed(4)}</span>` 
      : '';
      
    // Determine "Open" state
    let isOpen = false;
    if (hierarchyExpandMode === 'expanded') {
      isOpen = true;
    } else if (hierarchyExpandMode === 'best') {
      // Open if this node is on EITHER the True Path or Best Path
      if (isTruePath || isBestPath) isOpen = true;
    }

    // Leaf Node
    if (node.children.length === 0) {
      return `
        <div class="tree-leaf">
           <span class="${textClass}">${node.name}</span>${scoreDisplay}
        </div>
      `;
    } 
    
    // Parent Node
    const childrenHtml = node.children
      .sort((a,b) => a.name.localeCompare(b.name)) 
      .map(child => renderNode(child))
      .join('');

    return `
      <details ${isOpen ? 'open' : ''}>
        <summary class="${textClass}">
          ${node.name} ${scoreDisplay}
        </summary>
        <div class="tree-children">
          ${childrenHtml}
        </div>
      </details>
    `;
  };

  if (hierarchyRoots) {
    html += hierarchyRoots.map(root => renderNode(root)).join('');
  }
  
  html += `</div>`;
  contentDiv.innerHTML = html;
}

window.updateHierarchyExpandMode = function() {
  const el = document.getElementById('hierarchy-expand');
  if (el) {
    hierarchyExpandMode = el.value;
    if (selectedAnnotation) {
      updateDetailsPanel(selectedAnnotation);
    }
  }
}

function drawAnnotations(lineOpts = {}) {
  const canvas = document.getElementById('annotation-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  if (!annotationsVisible) return;

  // Use the Filtered List for drawing
  const anns = getFilteredAnnotations();
  
  anns.forEach(ann => drawAnnotation(ctx, ann, lineOpts));
}

function drawAnnotation(ctx, ann, lineOpts) {
  const category = cocoData.categories.find(c => c.id === ann.category_id);
  const catOptions = lineOpts[category.id] || { color: 'blue' };
  const isSelected = (selectedAnnotation && selectedAnnotation.id === ann.id);

  const modeElement = document.getElementById('annotation-type');
  const mode = modeElement ? modeElement.value : 'keypoint';

  if (isSelected) {
    if (ann.bbox) {
      const [x, y, w, h] = ann.bbox;
      ctx.save();
      ctx.strokeStyle = 'white';
      const baseLW = Math.max(3, ctx.canvas.width / 500);
      ctx.lineWidth = baseLW + 4; 
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
  }

  if (mode === 'bbox') {
    if (ann.bbox) {
      const [x, y, w, h] = ann.bbox;
      ctx.strokeStyle = catOptions.color;
      const baseLW = Math.max(3, ctx.canvas.width / 500); 
      ctx.lineWidth = baseLW; 
      ctx.strokeRect(x, y, w, h);
    }
  } else {
    const kp = ann.keypoints;
    if (kp) {
      const points = [];
      for (let i = 0; i < kp.length; i += 3) {
        points.push([kp[i], kp[i + 1]]);
      }
      if (category.skeleton) {
        const baseLW = Math.max(2, ctx.canvas.width / 600);
        ctx.lineWidth = baseLW;
        category.skeleton.forEach(([i, j]) => {
          const pt1 = points[i - 1];
          const pt2 = points[j - 1];
          if (pt1 && pt2) {
            const edgeOpts = (catOptions.end && catOptions.end[j]) || {};
            const lineEnd = edgeOpts.lineEnd || 'circle';
            drawEdge(ctx, pt1, pt2, catOptions.color, lineEnd);
          }
        });
      }
    }
  }

  if (labelsVisible && ann.bbox) {
    const [x, y, w, h] = ann.bbox;
    let labelText = category.name;
    
    if (ann.scores && ann.scores[category.id] !== undefined) {
      labelText += ` (${ann.scores[category.id].toFixed(2)})`;
    }

    ctx.save();
    const fontSize = Math.max(12, ctx.canvas.width / 60); 
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = 'top';
    
    const textMetrics = ctx.measureText(labelText);
    const textHeight = fontSize * 1.2;
    const padding = 4;
    const bgWidth = textMetrics.width + (padding * 2);
    const bgHeight = textHeight;

    ctx.fillStyle = catOptions.color; 
    ctx.fillRect(x, y - bgHeight, bgWidth, bgHeight);
    
    ctx.fillStyle = 'white'; 
    ctx.fillText(labelText, x + padding, y - bgHeight + (padding/2));
    ctx.restore();
  }
}

function drawEdge(ctx, pt1, pt2, color = 'blue', lineEnd = 'circle') {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(...pt1);
  ctx.lineTo(...pt2);
  ctx.stroke();

  const drawFn = pointDrawerMap[lineEnd] || pointDrawerMap['circle'];
  drawFn(ctx, pt1, pt2, color);
}

function drawCircle(ctx, pt1, pt2, color) {
  const r = Math.max(3, ctx.canvas.width / 500);
  ctx.beginPath();
  ctx.arc(...pt2, r, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawArrow(ctx, pt1, pt2, color) {
  const headLength = Math.max(10, ctx.canvas.width / 200);
  const dx = pt2[0] - pt1[0];
  const dy = pt2[1] - pt1[1];
  const angle = Math.atan2(dy, dx);
  ctx.beginPath();
  ctx.moveTo(pt2[0], pt2[1]);
  ctx.lineTo(pt2[0] - headLength * Math.cos(angle - Math.PI / 6), pt2[1] - headLength * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(pt2[0] - headLength * Math.cos(angle + Math.PI / 6), pt2[1] - headLength * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

const pointDrawerMap = {
  circle: drawCircle,
  arrow: drawArrow
};

function showImage(index) {
  if (!cocoData || !cocoData.images) return;
  
  if (index < 0) index = 0;
  if (index >= cocoData.images.length) index = cocoData.images.length - 1;

  currentIndex = index;
  
  selectedAnnotation = null;
  updateDetailsPanel(null);

  const imgData = cocoData.images[index];
  const imageElement = document.getElementById('coco-image');
  const canvas = document.getElementById('annotation-canvas');
  
  imageElement.onload = () => {
    canvas.width = imageElement.naturalWidth;
    canvas.height = imageElement.naturalHeight;
    drawAnnotations(globalLineOptions);
  };

  imageElement.src = imgData.coco_url;
}

window.navigate = function(delta) {
  if (!cocoData) return;
  const stepInput = document.getElementById('nav-step-size');
  let step = parseInt(stepInput.value, 10);
  if (isNaN(step) || step < 1) step = 1;
  const newIndex = currentIndex + (delta * step);
  showImage(newIndex);
};

window.nextImage = function () { window.navigate(1); };
window.prevImage = function () { window.navigate(-1); };

window.toggleAnnotations = function () {
  annotationsVisible = !annotationsVisible;
  const switchEl = document.getElementById('toggleSwitch');
  if (switchEl) switchEl.checked = annotationsVisible;
  drawAnnotations(globalLineOptions);
};

window.toggleLabels = function () {
  labelsVisible = !labelsVisible;
  drawAnnotations(globalLineOptions);
}

window.updateAnnotationType = function () {
  drawAnnotations(globalLineOptions);
};

window.toggleImageScale = function () {
  const checkbox = document.getElementById('scaleSwitch');
  imageScaled = checkbox ? checkbox.checked : true;
  updateImageScale();
}

function updateImageScale() {
  const container = document.getElementById('image-container');
  if (!container) return;
  if (imageScaled) {
    container.classList.add('fit-screen');
    container.classList.remove('original-size');
  } else {
    container.classList.remove('fit-screen');
    container.classList.add('original-size');
  }
}

window.main = function () {
  const url = document.getElementById('json-url').value;
  const hierUrl = document.getElementById('hierarchy-url').value;

  // Save to Local Storage
  localStorage.setItem('coco_json_url', url);
  localStorage.setItem('coco_hierarchy_url', hierUrl);

  loadCOCO(url, hierUrl, lineOptions);
};

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    return;
  }

  const stepInput = document.getElementById('nav-step-size');
  if (!stepInput) return;

  const setStep = (val) => {
    stepInput.value = val;
  };

  switch (e.key.toLowerCase()) {
    case 'a': setStep(1); window.navigate(-1); break;
    case 'd': setStep(1); window.navigate(1); break;
    case 's': setStep(10); window.navigate(-1); break;
    case 'w': setStep(10); window.navigate(1); break;
    case 'q': setStep(100); window.navigate(-1); break;
    case 'e': setStep(100); window.navigate(1); break;
  }
});
