let cocoData;
let currentIndex = 0;
let annotationsVisible = true;
let globalLineOptions = {};

// Expanded colorblind-safe palette (merged from Set1, Set2, Dark2, Paired, filtered)
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

/**
 * All categories will draw arrows at the end of each skeleton edge.
 * Colors are auto-assigned.
 */
const lineOptions = {}; // populated in loadCOCO for all categories with default arrows

/**
 * Generate a lineOptions object per category with default colors and arrows.
 *
 * @param {Array} categories - Array of COCO category objects
 * @param {Object} overrides - Partial overrides for specific categories
 * @returns {Object} - lineOptions by category ID
 */
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

/**
 * Create and populate a legend showing each category and its color.
 *
 * @param {Array} categories
 * @param {Object} lineOpts
 */
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
      <div style="width: 16px; height: 16px; background: ${color}; margin-right: 8px;"></div>
      <span>${cat.name}</span>
    `;
    legend.appendChild(div);
  });
}

/**
 * Load COCO JSON and initialize image and annotation structures.
 *
 * @param {string} url
 * @param {Object} overrideLineOptions
 */
async function loadCOCO(url, overrideLineOptions = {}) {
  const response = await fetch(url);
  cocoData = await response.json();

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

  // Auto-detect format logic
  const typeSelect = document.getElementById('annotation-type');
  let detectedType = 'keypoint'; // Default fallback
  
  // Find the first annotation that has either keypoints or bbox to determine type
  const validAnn = cocoData.annotations.find(a => (a.keypoints && a.keypoints.length) || a.bbox);
  
  if (validAnn) {
    if (validAnn.keypoints && validAnn.keypoints.length > 0) {
      detectedType = 'keypoint';
    } else if (validAnn.bbox && validAnn.bbox.length === 4) {
      detectedType = 'bbox';
    }
  }
  
  // Update dropdown to match detected type
  typeSelect.value = detectedType;

  showImage(0);
}

/**
 * Draw all annotations for the current image.
 *
 * @param {Object} lineOpts
 */
function drawAnnotations(lineOpts = {}) {
  const canvas = document.getElementById('annotation-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!annotationsVisible) return;

  const imgData = cocoData.images[currentIndex];
  const anns = cocoData.annotationsByImage[imgData.id] || [];

  anns.forEach(ann => drawAnnotation(ctx, ann, lineOpts));
}

/**
 * Draw skeleton edges for a single annotation.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} ann
 * @param {Object} lineOpts
 */
function drawAnnotation(ctx, ann, lineOpts) {
  const category = cocoData.categories.find(c => c.id === ann.category_id);
  const catOptions = lineOpts[category.id] || { color: 'blue' };
  
  // Check dropdown for mode
  const mode = document.getElementById('annotation-type').value;

  if (mode === 'bbox') {
    if (ann.bbox) {
      const [x, y, w, h] = ann.bbox;
      ctx.strokeStyle = catOptions.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
    }
    return;
  }

  // Fallback / Default to Keypoint Logic (Original)
  const kp = ann.keypoints;
  if (!kp) return; // Prevent crash if keypoints are missing in keypoint mode

  const points = [];
  for (let i = 0; i < kp.length; i += 3) {
    const x = kp[i], y = kp[i + 1];
    points.push([x, y]);
  }

  if (!category.skeleton) return;

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

/**
 * Draw a line segment with a specific end decoration.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {[number, number]} pt1
 * @param {[number, number]} pt2
 * @param {string} color
 * @param {string} lineEnd
 */
function drawEdge(ctx, pt1, pt2, color = 'blue', lineEnd = 'circle') {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(...pt1);
  ctx.lineTo(...pt2);
  ctx.stroke();

  const drawFn = pointDrawerMap[lineEnd] || pointDrawerMap['circle'];
  drawFn(ctx, pt1, pt2, color);
}

/**
 * Draw a circle at the end of a line.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {[number, number]} pt1
 * @param {[number, number]} pt2
 * @param {string} color
 */
function drawCircle(ctx, pt1, pt2, color) {
  ctx.beginPath();
  ctx.arc(...pt2, 3, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * Draw an arrowhead at the end of a line.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {[number, number]} pt1
 * @param {[number, number]} pt2
 * @param {string} color
 */
function drawArrow(ctx, pt1, pt2, color) {
  const headLength = 10;
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

/**
 * Display the image at the given index.
 *
 * @param {number} index
 */
function showImage(index) {
  if (!cocoData || index < 0 || index >= cocoData.images.length) return;

  currentIndex = index;
  const imgData = cocoData.images[index];
  const imageElement = document.getElementById('coco-image');
  const canvas = document.getElementById('annotation-canvas');

  imageElement.onload = () => {
    canvas.width = imageElement.width;
    canvas.height = imageElement.height;
    canvas.style.width = imageElement.width + 'px';
    canvas.style.height = imageElement.height + 'px';
    drawAnnotations(globalLineOptions);
  };

  imageElement.src = imgData.coco_url;
}

window.nextImage = function () {
  if (currentIndex < cocoData.images.length - 1) showImage(currentIndex + 1);
};

window.prevImage = function () {
  if (currentIndex > 0) showImage(currentIndex - 1);
};

window.toggleAnnotations = function () {
  annotationsVisible = !annotationsVisible;
  drawAnnotations(globalLineOptions);
};

window.updateAnnotationType = function () {
  drawAnnotations(globalLineOptions);
};

window.main = function () {
  const url = document.getElementById('json-url').value;
  loadCOCO(url, lineOptions);
};

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') {
    window.nextImage();
  } else if (e.key === 'ArrowLeft') {
    window.prevImage();
  }
});
