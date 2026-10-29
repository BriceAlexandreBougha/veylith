import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GameState, Piece } from "../lib/api";
import { getLocalLegalPaths } from "../lib/movement";

// Adjust this value to change mouse and touch rotation sensitivity.
export const BOARD_ROTATION_SPEED = 0.0032;
export const BOARD_WHEEL_ZOOM_SPEED = 0.0065;
export const BOARD_PINCH_ZOOM_SPEED = 0.012;

const UNIT_HEIGHT = 0.28;
const PIECE_STEP_DURATION = 180;
const HEIGHT_CHANGE_HOP = UNIT_HEIGHT * 0.24;
const EXIT_SEAM_COLOR = "#ffffff";
const TILE_GAP = 0.022;
const TILE_MODEL_VARIANTS = [
  { url: "/models/tiles/stone-light.glb", color: "#d6c8b2" },
  { url: "/models/tiles/stone-beige.glb", color: "#b7a58e" },
  { url: "/models/tiles/stone-gray.glb", color: "#888985" },
  { url: "/models/tiles/stone-slate-blue.glb", color: "#687985" },
  { url: "/models/tiles/stone-light-blue.glb", color: "#a5b4bc" },
];
const tileTemplateCache = new Map<number, Promise<THREE.Group>>();
const sharedTileGeometries = new WeakSet<THREE.BufferGeometry>();
const sharedTileMaterials = new WeakSet<THREE.Material>();

function loadTileTemplate(variant: number): Promise<THREE.Group> {
  const cached = tileTemplateCache.get(variant);
  if (cached) return cached;

  const url = TILE_MODEL_VARIANTS[variant]?.url;
  if (!url) return Promise.reject(new Error(`Variante de tuile inconnue : ${variant}`));

  const promise = new Promise<THREE.Group>((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => {
        gltf.scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          sharedTileGeometries.add(object.geometry);
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) sharedTileMaterials.add(material);
          object.castShadow = true;
          object.receiveShadow = true;
        });
        resolve(gltf.scene);
      },
      undefined,
      reject,
    );
  });
  tileTemplateCache.set(variant, promise);
  void promise.catch(() => tileTemplateCache.delete(variant));
  return promise;
}

function getTileVariant(pattern: number): number {
  const roll = pattern % 100;
  if (roll < 48) return 0;
  if (roll < 70) return 1;
  if (roll < 88) return 2;
  if (roll < 95) return 3;
  return 4;
}

function createStoneTexture(kind: "color" | "bump"): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.CanvasTexture(canvas);
  const image = context.createImageData(canvas.width, canvas.height);
  let seed = 7291;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const pixel = (y * canvas.width + x) * 4;
      seed = (seed * 16807) % 2147483647;
      const grain = (seed % 31) - 15;
      const cloud = Math.sin(x * 0.045) * 7 + Math.cos(y * 0.035) * 6;
      const shade = kind === "color"
        ? THREE.MathUtils.clamp(241 + grain * 0.35 + cloud * 0.35, 224, 255)
        : THREE.MathUtils.clamp(128 + grain * 1.7 + cloud * 1.8, 65, 195);
      image.data[pixel] = shade;
      image.data[pixel + 1] = shade;
      image.data[pixel + 2] = shade;
      image.data[pixel + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  // Hairline mineral veins add a restrained natural stone detail.
  seed = 9127;
  context.lineWidth = 0.7;
  context.strokeStyle = kind === "color" ? "rgba(71, 60, 45, 0.11)" : "rgba(45, 45, 45, 0.5)";
  for (let vein = 0; vein < 9; vein += 1) {
    seed = (seed * 16807) % 2147483647;
    const startX = seed % canvas.width;
    seed = (seed * 16807) % 2147483647;
    const startY = seed % canvas.height;
    context.beginPath();
    context.moveTo(startX, startY);
    context.quadraticCurveTo(
      startX + ((seed % 39) - 19),
      startY + 28 + (seed % 42),
      startX + ((seed % 55) - 27),
      startY + 70 + (seed % 53),
    );
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.15, 1.15);
  if (kind === "color") texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createExitHaloTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.CanvasTexture(canvas);
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.2, "rgba(255,255,255,0.025)");
  gradient.addColorStop(0.36, "rgba(255,255,255,0.12)");
  gradient.addColorStop(0.46, "rgba(255,255,255,0.55)");
  gradient.addColorStop(0.5, "rgba(255,255,255,1)");
  gradient.addColorStop(0.54, "rgba(255,255,255,0.55)");
  gradient.addColorStop(0.64, "rgba(255,255,255,0.12)");
  gradient.addColorStop(0.8, "rgba(255,255,255,0.025)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

interface GameBoard3DProps {
  game: GameState;
  disabled: boolean;
  hideIndicators: boolean;
  selectedPieceId: string | null;
  legalDestinations: Set<string>;
  attackablePieceIds: Set<string>;
  insufficientAttackPieceIds: Set<string>;
  interactiveCells: Set<string>;
  routePath: { row: number; col: number }[];
  routeIsAttack: boolean;
  movementPathOverride: {
    pieceId: string;
    path: { row: number; col: number }[];
    special: string | null;
  } | null;
  onCellClick: (row: number, col: number, input: "mouse" | "touch") => void;
  onCellContextMenu: (row: number, col: number) => void;
}

interface CellVisual {
  tile: THREE.Mesh;
  baseMaterial: THREE.MeshStandardMaterial;
  glowMaterial: THREE.MeshStandardMaterial;
}

interface LatestBoardProps {
  disabled: boolean;
  interactiveCells: Set<string>;
  onCellClick: (row: number, col: number, input: "mouse" | "touch") => void;
  onCellContextMenu: (row: number, col: number) => void;
  hideIndicators: boolean;
  selectedPieceId: string | null;
  legalDestinations: Set<string>;
  attackablePieceIds: Set<string>;
  insufficientAttackPieceIds: Set<string>;
  pieces: Piece[];
}

function applyCellIndicator(key: string, visual: CellVisual, props: LatestBoardProps): void {
  if (props.hideIndicators) {
    visual.tile.material = visual.baseMaterial;
    return;
  }

  const selectedPiece = props.pieces.find((piece) => piece.id === props.selectedPieceId);
  const selectedKey = selectedPiece?.position
    ? `${selectedPiece.position.row}:${selectedPiece.position.col}`
    : null;
  const [row, col] = key.split(":").map(Number);
  const piece = props.pieces.find((candidate) =>
    candidate.position?.row === row && candidate.position.col === col
      && !candidate.captured && !candidate.finished,
  );
  let color: string | null = null;
  if (key === selectedKey) color = "#c0aa78";
  else if (piece && props.attackablePieceIds.has(piece.id)) color = "#bb5f55";
  else if (piece && props.insufficientAttackPieceIds.has(piece.id)) color = "#b89760";
  else if (props.legalDestinations.has(key)) color = "#5a9eaf";

  if (!color) {
    visual.tile.material = visual.baseMaterial;
    return;
  }

  const tint = new THREE.Color(color);
  visual.glowMaterial.color.copy(visual.baseMaterial.color).lerp(tint, 0.38);
  visual.glowMaterial.emissive.copy(tint);
  visual.glowMaterial.emissiveIntensity = 0.75;
  visual.tile.material = visual.glowMaterial;
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: THREE.Vector3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function createFacetedGeometry(rings: Array<{ y: number; radius: number }>, sides: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const angleOffset = Math.PI / sides;
  for (const ring of rings) {
    for (let side = 0; side < sides; side += 1) {
      const angle = (side / sides) * Math.PI * 2 + angleOffset;
      positions.push(Math.cos(angle) * ring.radius, ring.y, Math.sin(angle) * ring.radius);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    for (let side = 0; side < sides; side += 1) {
      const current = ring * sides + side;
      const next = ring * sides + ((side + 1) % sides);
      const upper = (ring + 1) * sides + side;
      const upperNext = (ring + 1) * sides + ((side + 1) % sides);
      indices.push(current, upper, next, next, upper, upperNext);
    }
  }
  const bottomCenter = positions.length / 3;
  positions.push(0, rings[0].y, 0);
  const topCenter = positions.length / 3;
  positions.push(0, rings[rings.length - 1].y, 0);
  for (let side = 0; side < sides; side += 1) {
    const next = (side + 1) % sides;
    indices.push(bottomCenter, side, next);
    const topStart = (rings.length - 1) * sides;
    indices.push(topCenter, topStart + side, topStart + next);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function pieceMaterials(
  owner: Piece["owner"],
  colorTexture: THREE.CanvasTexture,
  bumpTexture: THREE.CanvasTexture,
): {
  stone: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
} {
  const ivory = owner === "WHITE";
  return {
    stone: new THREE.MeshStandardMaterial({
      color: ivory ? "#d9cbb2" : "#353638",
      map: colorTexture,
      bumpMap: bumpTexture,
      bumpScale: 0.018,
      roughness: ivory ? 0.86 : 0.82,
      metalness: 0.015,
      flatShading: true,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: ivory ? "#b4a487" : "#555454",
      map: colorTexture,
      bumpMap: bumpTexture,
      bumpScale: 0.014,
      roughness: 0.74,
      metalness: 0.025,
      flatShading: true,
    }),
  };
}

function createPieceModel(
  piece: Piece,
  colorTexture: THREE.CanvasTexture,
  bumpTexture: THREE.CanvasTexture,
): THREE.Group {
  const group = new THREE.Group();
  const { stone, accent } = pieceMaterials(piece.owner, colorTexture, bumpTexture);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.34, 0.14, 8), accent);
  base.position.y = 0.06;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const lowerRim = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.34, 0.055, 8), stone);
  lowerRim.position.y = 0.035;
  lowerRim.castShadow = true;
  lowerRim.receiveShadow = true;
  group.add(lowerRim);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.245, 0.012, 5, 20), accent);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.125;
  group.add(ring);

  if (piece.piece_type === "EXPLORER") {
    const crystal = new THREE.Mesh(createFacetedGeometry([
      { y: 0.16, radius: 0.13 },
      { y: 0.28, radius: 0.23 },
      { y: 0.46, radius: 0.27 },
      { y: 0.68, radius: 0.17 },
      { y: 0.98, radius: 0.035 },
    ], 5), stone);
    crystal.castShadow = true;
    crystal.receiveShadow = true;
    group.add(crystal);
    crystal.rotation.y = 0.18;
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.27, 0.12, 5), accent);
    collar.position.y = 0.19;
    collar.castShadow = true;
    group.add(collar);
  } else if (piece.piece_type === "VANGUARD") {
    const body = new THREE.Mesh(createFacetedGeometry([
      { y: 0.17, radius: 0.18 },
      { y: 0.3, radius: 0.28 },
      { y: 0.42, radius: 0.27 },
      { y: 0.84, radius: 0.18 },
      { y: 0.98, radius: 0.12 },
    ], 6), stone);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.3, 0.1, 6), accent);
    shoulder.position.y = 0.25;
    shoulder.castShadow = true;
    group.add(shoulder);
  } else {
    const column = new THREE.Mesh(createFacetedGeometry([
      { y: 0.17, radius: 0.21 },
      { y: 0.3, radius: 0.22 },
      { y: 0.78, radius: 0.19 },
      { y: 0.84, radius: 0.22 },
    ], 8), stone);
    column.castShadow = true;
    column.receiveShadow = true;
    group.add(column);
    const crown = new THREE.Mesh(createFacetedGeometry([
      { y: 0.79, radius: 0.2 },
      { y: 0.88, radius: 0.31 },
      { y: 1.02, radius: 0.27 },
      { y: 1.1, radius: 0.17 },
    ], 6), accent);
    crown.castShadow = true;
    group.add(crown);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 0.08, 6), stone);
    cap.position.y = 1.1;
    cap.castShadow = true;
    group.add(cap);
  }

  return group;
}

const PIECE_MODEL_URLS: Record<Piece["owner"], Record<Piece["piece_type"], string>> = {
  WHITE: {
    EXPLORER: "/models/pieces/white_explorer/Meshy_AI_Silent_Prism_20261027_texture_fbx/Meshy_AI_Silent_Prism_20261027_texture.fbx",
    VANGUARD: "/models/pieces/white_vanguard/Meshy_AI_Geometric_Stone_Monolith_20261027_texture_fbx/Meshy_AI_Geometric_Stone_Monolith_20261027_texture.fbx",
    SENTINEL: "/models/pieces/white_sentinel/Meshy_AI_Sandstone_Obelisk_20261027_texture_fbx/Meshy_AI_Sandstone_Obelisk_20261027_texture.fbx",
  },
  BLACK: {
    EXPLORER: "/models/pieces/black_explorer/Meshy_AI_Obsidian_Spire_20261027_texture_fbx/Meshy_AI_Obsidian_Spire_20261027_texture.fbx",
    VANGUARD: "/models/pieces/black_vanguard/Meshy_AI_Obsidian_Beacon_20261027_texture_fbx/Meshy_AI_Obsidian_Beacon_20261027_texture.fbx",
    SENTINEL: "/models/pieces/black_sentinel/Meshy_AI_Obsidian_Monolith_20261027_texture_fbx/Meshy_AI_Obsidian_Monolith_20261027_texture.fbx",
  },
};

const PIECE_MODEL_COUNT = Object.values(PIECE_MODEL_URLS)
  .reduce((count, models) => count + Object.keys(models).length, 0);

function normalizePieceModel(source: THREE.Group, pieceType: Piece["piece_type"]): THREE.Group {
  const model = source;
  model.updateMatrixWorld(true);
  let bounds = new THREE.Box3().setFromObject(model);
  const dimensions = bounds.getSize(new THREE.Vector3());
  if (dimensions.y <= 0) return model;

  // One board tile represents roughly 4 cm; fit each model to its reference height and tile footprint.
  const targetHeight = pieceType === "EXPLORER" ? 0.875 : pieceType === "VANGUARD" ? 0.75 : 0.95;
  const horizontalSize = Math.max(dimensions.x, dimensions.z, 0.001);
  const scale = Math.min(targetHeight / dimensions.y, 0.82 / horizontalSize);
  model.scale.multiplyScalar(scale);
  model.updateMatrixWorld(true);
  bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.y -= bounds.min.y;
  model.position.z -= center.z;
  model.updateMatrixWorld(true);

  model.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return model;
}

function disposePieceResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of meshMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

function disposeProceduralPiece(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => material.dispose());
  });
}

export default function GameBoard3D({
  game,
  disabled,
  hideIndicators,
  selectedPieceId,
  legalDestinations,
  attackablePieceIds,
  insufficientAttackPieceIds,
  interactiveCells,
  routePath,
  routeIsAttack,
  movementPathOverride,
  onCellClick,
  onCellContextMenu,
}: GameBoard3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [pieceLoadProgress, setPieceLoadProgress] = useState({
    gameId: game.game_id,
    settled: 0,
    failed: 0,
  });
  const currentLoadProgress = pieceLoadProgress.gameId === game.game_id
    ? pieceLoadProgress
    : { gameId: game.game_id, settled: 0, failed: 0 };
  const pieceModelsReady = currentLoadProgress.settled === PIECE_MODEL_COUNT;
  const previousGameRef = useRef<GameState | null>(null);
  const latestProps = useRef<LatestBoardProps>({
    disabled,
    interactiveCells,
    onCellClick,
    hideIndicators,
    selectedPieceId,
    legalDestinations,
    attackablePieceIds,
    insufficientAttackPieceIds,
    pieces: game.pieces,
    onCellContextMenu,
  });
  const cellVisualsRef = useRef(new Map<string, CellVisual>());
  const pieceModelsRef = useRef(new Map<string, THREE.Group>());
  const exitSeamsRef = useRef(new Map<number, THREE.Group>());
  const routeVisualRef = useRef<THREE.Group | null>(null);
  const renderRequestRef = useRef<((shadowsDirty?: boolean) => void) | null>(null);
  const pieceAnimationsRef = useRef(new Map<string, {
    points: THREE.Vector3[];
    startedAt: number;
  }>());
  const exitAnimationsRef = useRef(new Map<string, {
    startedAt: number;
    startPosition: THREE.Vector3;
    materials: THREE.Material[];
    ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  }>());

  latestProps.current = {
    disabled,
    interactiveCells,
    onCellClick,
    hideIndicators,
    selectedPieceId,
    legalDestinations,
    attackablePieceIds,
    insufficientAttackPieceIds,
    pieces: game.pieces,
    onCellContextMenu,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setPieceLoadProgress({ gameId: game.game_id, settled: 0, failed: 0 });

    const size = game.board_size;
    const half = (size - 1) / 2;
    const maxHeight = Math.max(...game.heights.flat());
    const scene = new THREE.Scene();
    scene.background = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = "game-board-canvas";
    renderer.domElement.setAttribute("aria-label", "Plateau de jeu 3D interactif");
    renderer.domElement.setAttribute("role", "application");
    renderer.domElement.style.visibility = "hidden";
    host.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    let yaw = 0.68;
    let pitch = 0.72;
    let distance = size * 1.34;
    let minDistance = size * 1.15;
    let maxDistance = size * 3.4;
    const target = new THREE.Vector3(0, maxHeight * UNIT_HEIGHT * 0.43, 0);
    const boundsCorners: THREE.Vector3[] = [];
    const addCellBounds = (row: number, col: number, y: number, radius: number) => {
      const x = col - half;
      const z = row - half;
      for (const dx of [-radius, radius]) {
        for (const dz of [-radius, radius]) {
          boundsCorners.push(new THREE.Vector3(x + dx, y, z + dz));
        }
      }
    };
    const pieceCells = new Set<string>();
    for (const piece of game.pieces) {
      if (piece.position && !piece.captured && !piece.finished) {
        pieceCells.add(`${piece.position.row}:${piece.position.col}`);
      }
    }
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const height = game.heights[row]?.[col] ?? 0;
        const isPerimeter = row === 0 || col === 0 || row === size - 1 || col === size - 1;
        const hasPiece = pieceCells.has(`${row}:${col}`);
        if (isPerimeter || height >= maxHeight - 1 || hasPiece) {
          addCellBounds(row, col, height * UNIT_HEIGHT, 0.49);
        }
        if (hasPiece) addCellBounds(row, col, height * UNIT_HEIGHT + 1.12, 0.37);
      }
    }
    const baseExtent = size / 2 + 0.08;
    for (const x of [-baseExtent, baseExtent]) {
      for (const z of [-baseExtent, baseExtent]) {
        boundsCorners.push(new THREE.Vector3(x, -0.62, z));
        boundsCorners.push(new THREE.Vector3(x, -UNIT_HEIGHT, z));
      }
    }
    const updateCamera = () => {
      const horizontal = distance * Math.cos(pitch);
      camera.position.set(
        target.x + horizontal * Math.sin(yaw),
        target.y + distance * Math.sin(pitch),
        target.z + horizontal * Math.cos(yaw),
      );
      camera.lookAt(target);
    };
    updateCamera();
    const getFramingDistance = () => {
      const previousDistance = distance;
      let candidate = size * 1.12;
      for (let attempt = 0; attempt < 14; attempt += 1) {
        distance = candidate;
        updateCamera();
        camera.updateMatrixWorld(true);
        let overflow = 1;
        for (const corner of boundsCorners) {
          const projected = corner.clone().project(camera);
          overflow = Math.max(overflow, Math.abs(projected.x) / 0.985, Math.abs(projected.y) / 0.985);
        }
        if (overflow <= 1.01) {
          distance = previousDistance;
          updateCamera();
          return candidate;
        }
        candidate *= overflow * 1.035;
      }
      distance = previousDistance;
      updateCamera();
      return candidate;
    };
    const keepBoardFramed = () => {
      minDistance = getFramingDistance();
      maxDistance = Math.max(size * 3.4, minDistance * 1.7);
      distance = THREE.MathUtils.clamp(Math.max(distance, minDistance), minDistance, maxDistance);
      updateCamera();
    };
    const rotateWithoutZoom = (nextYaw: number, nextPitch: number) => {
      const currentYaw = yaw;
      const currentPitch = pitch;
      const viewFits = (progress: number) => {
        yaw = currentYaw + (nextYaw - currentYaw) * progress;
        pitch = currentPitch + (nextPitch - currentPitch) * progress;
        updateCamera();
        camera.updateMatrixWorld(true);
        return boundsCorners.every((corner) => {
          const projected = corner.clone().project(camera);
          return Math.abs(projected.x) <= 0.985 && Math.abs(projected.y) <= 0.985;
        });
      };
      if (viewFits(1)) return;
      let low = 0;
      let high = 1;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const middle = (low + high) / 2;
        if (viewFits(middle)) low = middle;
        else high = middle;
      }
      viewFits(low);
    };

    scene.add(new THREE.HemisphereLight("#f7f7f3", "#454642", 1.62));
    const keyLight = new THREE.DirectionalLight("#fffdf8", 1.95);
    keyLight.position.set(-size * 0.85, size * 1.5, size * 0.8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -size;
    keyLight.shadow.camera.right = size;
    keyLight.shadow.camera.top = size;
    keyLight.shadow.camera.bottom = -size;
    keyLight.shadow.bias = -0.0003;
    keyLight.shadow.radius = 4;
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight("#e5ebef", 0.72);
    fillLight.position.set(size, size * 0.65, -size);
    scene.add(fillLight);

    const board = new THREE.Group();
    // The camera faces row 9: rotate the board so White's row 0 is nearest.
    board.rotation.y = game.my_color === "WHITE" ? Math.PI : 0;
    scene.add(board);
    const routeVisual = new THREE.Group();
    routeVisual.renderOrder = 5;
    board.add(routeVisual);
    routeVisualRef.current = routeVisual;
    const exitSeams = new Map<number, THREE.Group>();
    const exitHaloTexture = createExitHaloTexture();
    const exitHaloMaterial = new THREE.MeshBasicMaterial({
      map: exitHaloTexture,
      color: "#ffffff",
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const exitInnerGlowMaterial = new THREE.MeshBasicMaterial({
      color: "#eaf8ff",
      transparent: true,
      opacity: 0.68,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const exitCoreMaterial = new THREE.MeshBasicMaterial({
      color: EXIT_SEAM_COLOR,
      toneMapped: false,
    });
    for (const row of [0, size - 1]) {
      const seam = new THREE.Group();
      seam.userData.exitRow = row;
      const edgeDirection = row === 0 ? -1 : 1;
      const edgeZ = row - half + edgeDirection * 0.455;
      for (let col = 0; col < size; col += 1) {
        const height = game.heights[row]?.[col] ?? 1;
        const x = col - half;
        const surfaceY = height * UNIT_HEIGHT;
        const halo = new THREE.Mesh(
          new THREE.PlaneGeometry(1.02, 0.34),
          exitHaloMaterial,
        );
        halo.rotation.x = -Math.PI / 2;
        halo.position.set(x, surfaceY + 0.003, edgeZ);
        halo.castShadow = false;
        halo.receiveShadow = false;
        seam.add(halo);

        const innerGlow = new THREE.Mesh(
          new THREE.BoxGeometry(1.008, 0.004, 0.038),
          exitInnerGlowMaterial,
        );
        innerGlow.position.set(x, surfaceY + 0.004, edgeZ);
        innerGlow.castShadow = false;
        innerGlow.receiveShadow = false;
        seam.add(innerGlow);

        const core = new THREE.Mesh(
          new THREE.BoxGeometry(1.008, 0.009, 0.012),
          exitCoreMaterial,
        );
        core.position.set(x, surfaceY + 0.006, edgeZ);
        core.castShadow = false;
        core.receiveShadow = false;
        seam.add(core);

        if (col === 0) continue;
        const previousHeight = game.heights[row]?.[col - 1] ?? 1;
        if (previousHeight === height) continue;
        const riserHeight = Math.abs(height - previousHeight) * UNIT_HEIGHT;
        const riser = new THREE.Mesh(
          new THREE.BoxGeometry(0.012, riserHeight, 0.014),
          exitCoreMaterial,
        );
        riser.position.set(
          col - half - 0.5,
          (height + previousHeight) * UNIT_HEIGHT / 2,
          edgeZ,
        );
        riser.castShadow = false;
        riser.receiveShadow = false;
        seam.add(riser);
      }
      seam.visible = (game.my_color === "WHITE" ? size - 1 : 0) === row;
      board.add(seam);
      exitSeams.set(row, seam);
    }
    exitSeamsRef.current = exitSeams;
    const cellVisuals = new Map<string, CellVisual>();
    const pieceModels = new Map<string, THREE.Group>();
    const pendingTileStacks: Array<{
      cell: THREE.Group;
      fallback: THREE.Mesh;
      variant: number;
      position: THREE.Vector3;
      key: string;
      isTop: boolean;
    }> = [];
    const unitGeometry = new RoundedBoxGeometry(
      1 - TILE_GAP,
      UNIT_HEIGHT,
      1 - TILE_GAP,
      3,
      0.034,
    );
    const stoneColorTexture = createStoneTexture("color");
    const stoneBumpTexture = createStoneTexture("bump");
    const base = new THREE.Mesh(
      new RoundedBoxGeometry(size + 0.16, 0.32, size + 0.16, 3, 0.045),
      new THREE.MeshStandardMaterial({ color: "#292a2b", roughness: 0.88 }),
    );
    base.position.y = -UNIT_HEIGHT - 0.16;
    base.receiveShadow = true;
    base.castShadow = true;
    board.add(base);

    const tileMaterials = TILE_MODEL_VARIANTS.map(({ color }) =>
      new THREE.MeshStandardMaterial({
          color,
          map: stoneColorTexture,
          roughness: 0.91,
          bumpMap: stoneBumpTexture,
          bumpScale: 0.026,
          flatShading: true,
        }),
    );
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const key = `${row}:${col}`;
        const height = game.heights[row]?.[col] ?? 1;
        const cell = new THREE.Group();
        cell.position.set(col - half, 0, row - half);
        cell.userData = { row, col };
        board.add(cell);

        // Height zero still has a visible stone surface at board level.
        // The shared bottom course keeps every square framed by fine joints.
        let topTile: THREE.Mesh | null = null;
        let topMaterial: THREE.MeshStandardMaterial | null = null;
        const stonePattern = (
          (row + 19) * 73856093 ^ (col + 23) * 19349663 ^ (row * col + 5) * 83492791
        ) >>> 0;
        const variant = getTileVariant(stonePattern);
        for (let stackIndex = 0; stackIndex <= height; stackIndex += 1) {
          const tilePosition = new THREE.Vector3(0, (stackIndex - 0.5) * UNIT_HEIGHT, 0);
          const tile = addMesh(
            cell,
            unitGeometry,
            tileMaterials[variant],
            tilePosition,
          );
          pendingTileStacks.push({
            cell,
            fallback: tile,
            variant,
            position: tilePosition,
            key,
            isTop: stackIndex === height,
          });
          if (stackIndex === height) {
            topTile = tile;
            topMaterial = tileMaterials[variant];
          }
        }

        if (!topTile || !topMaterial) continue;
        const glowMaterial = topMaterial.clone();
        glowMaterial.emissiveIntensity = 0.62;
        cellVisuals.set(key, { tile: topTile, baseMaterial: topMaterial, glowMaterial });
      }
    }

    let sceneDisposed = false;
    const stacksByVariant = new Map<number, typeof pendingTileStacks>();
    for (const stack of pendingTileStacks) {
      const stacks = stacksByVariant.get(stack.variant) ?? [];
      stacks.push(stack);
      stacksByVariant.set(stack.variant, stacks);
    }
    for (const [variant, stacks] of stacksByVariant) {
      void loadTileTemplate(variant).then((template) => {
        if (sceneDisposed) return;
        for (const stack of stacks) {
          const tileInstance = template.clone(true);
          tileInstance.position.copy(stack.position);
          const tileMeshes: THREE.Mesh[] = [];
          tileInstance.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            object.castShadow = true;
            object.receiveShadow = true;
            tileMeshes.push(object);
          });
          stack.cell.add(tileInstance);
          stack.cell.remove(stack.fallback);

          const tileMesh = tileMeshes[0];
          if (stack.isTop && tileMesh) {
            const baseMaterial = tileMesh.material;
            if (baseMaterial instanceof THREE.MeshStandardMaterial) {
              const visual = {
                tile: tileMesh,
                baseMaterial,
                glowMaterial: baseMaterial.clone(),
              };
              cellVisuals.set(stack.key, visual);
              applyCellIndicator(stack.key, visual, latestProps.current);
            }
          }
        }
        renderRequestRef.current?.(true);
      }).catch((error: unknown) => {
        console.warn(`Impossible de charger les tuiles 3D (${variant}).`, error);
      });
    }

    for (const piece of game.pieces) {
      if (!piece.position || piece.captured || piece.finished) continue;
      const model = createPieceModel(piece, stoneColorTexture, stoneBumpTexture);
      model.position.set(
        piece.position.col - half,
        (game.heights[piece.position.row]?.[piece.position.col] ?? 1) * UNIT_HEIGHT,
        piece.position.row - half,
      );
      model.userData = {
        pieceId: piece.id,
        row: piece.position.row,
        col: piece.position.col,
        visualTarget: model.position.clone(),
      };
      board.add(model);
      pieceModels.set(piece.id, model);
    }
    cellVisualsRef.current = cellVisuals;
    pieceModelsRef.current = pieceModels;

    const loadedTemplates = new Map<string, THREE.Group>();
    const pieceTemplates = Object.entries(PIECE_MODEL_URLS).flatMap(([owner, models]) =>
      Object.entries(models).map(([pieceType, url]) => ({
        owner: owner as Piece["owner"],
        pieceType: pieceType as Piece["piece_type"],
        url,
        key: `${owner}:${pieceType}`,
      })),
    );
    let settledModels = 0;
    let failedModels = 0;
    const settlePieceModel = (failed = false) => {
      if (sceneDisposed) return;
      settledModels += 1;
      if (failed) failedModels += 1;
      setPieceLoadProgress({
        gameId: game.game_id,
        settled: settledModels,
        failed: failedModels,
      });
      if (settledModels === PIECE_MODEL_COUNT) {
        renderer.shadowMap.needsUpdate = true;
        renderRequestRef.current?.(true);
      }
    };
    const fbxLoader = new FBXLoader();
    for (const pieceTemplate of pieceTemplates) {
      fbxLoader.load(
        pieceTemplate.url,
        (source) => {
          const template = normalizePieceModel(source, pieceTemplate.pieceType);
          if (sceneDisposed) {
            disposePieceResources(template);
            return;
          }
          loadedTemplates.set(pieceTemplate.key, template);
          for (const matchingPiece of game.pieces) {
            if (
              matchingPiece.owner !== pieceTemplate.owner ||
              matchingPiece.piece_type !== pieceTemplate.pieceType
            ) continue;
            const fallback = pieceModels.get(matchingPiece.id);
            if (!fallback) continue;
            const replacement = new THREE.Group();
            replacement.add(template.clone(true));
            replacement.position.copy(fallback.position);
            replacement.userData = { ...fallback.userData };
            board.add(replacement);
            board.remove(fallback);
            disposeProceduralPiece(fallback);
            pieceModels.set(matchingPiece.id, replacement);
          }
          settlePieceModel();
        },
        undefined,
        (error) => {
          console.warn(`Impossible de charger le modèle ${pieceTemplate.key}.`, error);
          settlePieceModel(true);
        },
      );
    }

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      renderer.setSize(bounds.width, bounds.height, false);
      camera.aspect = bounds.width / bounds.height;
      camera.fov = camera.aspect < 1
        ? THREE.MathUtils.radToDeg(
          2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(44 / 2)) / camera.aspect),
        )
        : 34;
      camera.updateProjectionMatrix();
      keepBoardFramed();
      renderRequestRef.current?.();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const touchPoints = new Map<number, THREE.Vector2>();
    const pointerStarts = new Map<number, { x: number; y: number; button: number }>();
    let rotatingMouse = false;
    let previousMouse = { x: 0, y: 0 };
    let touchGesture = false;
    let animationFrame = 0;
    const render = () => {
      animationFrame = 0;
      if (document.visibilityState === "hidden") return;
      const now = performance.now();
      for (const [pieceId, animation] of exitAnimationsRef.current) {
        const model = pieceModelsRef.current.get(pieceId);
        const progress = THREE.MathUtils.clamp((now - animation.startedAt) / 850, 0, 1);
        const eased = 1 - (1 - progress) ** 3;
        if (model) {
          model.position.copy(animation.startPosition);
          model.position.y += eased * 0.72;
          model.rotation.y += 0.035;
          model.scale.setScalar(1 - eased * 0.72);
          for (const material of animation.materials) {
            if ("opacity" in material) material.opacity = 1 - eased;
          }
        }
        animation.ring.scale.setScalar(0.65 + eased * 1.8);
        animation.ring.material.opacity = (1 - eased) * 0.65;
        if (progress >= 1) {
          if (model) {
            model.visible = false;
            model.scale.setScalar(1);
          }
          animation.ring.parent?.remove(animation.ring);
          animation.ring.geometry.dispose();
          animation.ring.material.dispose();
          animation.materials.forEach((material) => material.dispose());
          exitAnimationsRef.current.delete(pieceId);
        }
      }
      for (const [pieceId, animation] of pieceAnimationsRef.current) {
        const model = pieceModelsRef.current.get(pieceId);
        if (!model) {
          pieceAnimationsRef.current.delete(pieceId);
          continue;
        }
        const segmentCount = animation.points.length - 1;
        const duration = segmentCount * PIECE_STEP_DURATION;
        const progress = THREE.MathUtils.clamp((now - animation.startedAt) / duration, 0, 1);
        if (progress >= 1) {
          model.position.copy(animation.points[animation.points.length - 1]);
          pieceAnimationsRef.current.delete(pieceId);
          continue;
        }
        const elapsed = now - animation.startedAt;
        const segmentIndex = Math.min(Math.floor(elapsed / PIECE_STEP_DURATION), segmentCount - 1);
        const segmentProgress = THREE.MathUtils.clamp(
          (elapsed - segmentIndex * PIECE_STEP_DURATION) / PIECE_STEP_DURATION,
          0,
          1,
        );
        const eased = segmentProgress * segmentProgress * (3 - 2 * segmentProgress);
        const from = animation.points[segmentIndex];
        const to = animation.points[segmentIndex + 1];
        model.position.lerpVectors(from, to, eased);
        if (Math.abs(to.y - from.y) > 0.001) {
          model.position.y += Math.sin(Math.PI * eased) * HEIGHT_CHANGE_HOP;
        }
      }
      if (pieceAnimationsRef.current.size || exitAnimationsRef.current.size) {
        renderer.shadowMap.needsUpdate = true;
      }
      renderer.render(scene, camera);
      if (pieceAnimationsRef.current.size || exitAnimationsRef.current.size) requestRender();
    };
    const requestRender = (shadowsDirty = false) => {
      if (shadowsDirty) renderer.shadowMap.needsUpdate = true;
      if (animationFrame || document.visibilityState === "hidden") return;
      animationFrame = window.requestAnimationFrame(render);
    };
    renderRequestRef.current = requestRender;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestRender();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    requestRender(true);

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        event.preventDefault();
        touchPoints.set(event.pointerId, new THREE.Vector2(event.clientX, event.clientY));
        pointerStarts.set(event.pointerId, { x: event.clientX, y: event.clientY, button: 0 });
        if (touchPoints.size >= 2) touchGesture = true;
        renderer.domElement.setPointerCapture(event.pointerId);
        return;
      }
      if (event.button === 1) {
        event.preventDefault();
        rotatingMouse = true;
        previousMouse = { x: event.clientX, y: event.clientY };
        renderer.domElement.setPointerCapture(event.pointerId);
      } else if (event.button === 0) {
        pointerStarts.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
          button: event.button,
        });
      } else if (event.button === 2) {
        event.preventDefault();
        pointerStarts.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
          button: event.button,
        });
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" && touchPoints.has(event.pointerId)) {
        event.preventDefault();
        const previous = touchPoints.get(event.pointerId)!;
        const current = new THREE.Vector2(event.clientX, event.clientY);
        touchPoints.set(event.pointerId, current);
        if (touchPoints.size >= 2) {
          const points = [...touchPoints.values()];
          const previousPoints = points.map((point, index) =>
            index === [...touchPoints.keys()].indexOf(event.pointerId) ? previous : point,
          );
          const previousCenter = previousPoints[0].clone().add(previousPoints[1]).multiplyScalar(0.5);
          const currentCenter = points[0].clone().add(points[1]).multiplyScalar(0.5);
          const previousDistance = previousPoints[0].distanceTo(previousPoints[1]);
          const currentDistance = points[0].distanceTo(points[1]);
          yaw -= (currentCenter.x - previousCenter.x) * BOARD_ROTATION_SPEED;
          pitch = THREE.MathUtils.clamp(
            pitch + (currentCenter.y - previousCenter.y) * BOARD_ROTATION_SPEED,
            0.42,
            1.18,
          );
          distance = THREE.MathUtils.clamp(
            distance - (currentDistance - previousDistance) * BOARD_PINCH_ZOOM_SPEED,
            minDistance,
            maxDistance,
          );
          keepBoardFramed();
          rotateWithoutZoom(
            yaw - (currentCenter.x - previousCenter.x) * BOARD_ROTATION_SPEED,
            THREE.MathUtils.clamp(
              pitch + (currentCenter.y - previousCenter.y) * BOARD_ROTATION_SPEED,
              0.42,
              1.18,
            ),
          );
          requestRender();
        }
        return;
      }
      if (rotatingMouse) {
        const deltaX = event.clientX - previousMouse.x;
        const deltaY = event.clientY - previousMouse.y;
        const nextYaw = yaw - deltaX * BOARD_ROTATION_SPEED;
        const nextPitch = THREE.MathUtils.clamp(pitch + deltaY * BOARD_ROTATION_SPEED, 0.42, 1.18);
        previousMouse = { x: event.clientX, y: event.clientY };
        rotateWithoutZoom(nextYaw, nextPitch);
        requestRender();
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const start = pointerStarts.get(event.pointerId);
      if (event.pointerType === "touch") {
        touchPoints.delete(event.pointerId);
        if (start && !touchGesture && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) {
          handleCellHit(event.clientX, event.clientY, "touch");
        }
        if (touchPoints.size === 0) touchGesture = false;
      } else if (start?.button === 0 && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) {
        handleCellHit(event.clientX, event.clientY, "mouse");
      } else if (start?.button === 2 && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) {
        handleCellHit(event.clientX, event.clientY, "mouse", true);
      }
      pointerStarts.delete(event.pointerId);
      if (event.button === 1) rotatingMouse = false;
    };

    function handleCellHit(
      clientX: number,
      clientY: number,
      input: "mouse" | "touch",
      routeClick = false,
    ) {
      if (latestProps.current.disabled) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((clientX - bounds.left) / bounds.width) * 2 - 1,
        -((clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObjects(board.children, true);
      for (const intersection of intersections) {
        let object: THREE.Object3D | null = intersection.object;
        while (object && typeof object.userData.row !== "number") object = object.parent;
        if (object) {
          if (!latestProps.current.interactiveCells.has(`${object.userData.row}:${object.userData.col}`)) {
            return;
          }
          if (routeClick) {
            latestProps.current.onCellContextMenu(object.userData.row, object.userData.col);
          } else {
            latestProps.current.onCellClick(object.userData.row, object.userData.col, input);
          }
          return;
        }
      }
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      distance = THREE.MathUtils.clamp(
        distance + event.deltaY * BOARD_WHEEL_ZOOM_SPEED,
        minDistance,
        maxDistance,
      );
      keepBoardFramed();
      requestRender();
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);

    return () => {
      sceneDisposed = true;
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (renderRequestRef.current === requestRender) renderRequestRef.current = null;
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      const geometries = new Set<THREE.BufferGeometry>([unitGeometry]);
      const materials = new Set<THREE.Material>(tileMaterials);
      for (const visual of cellVisuals.values()) materials.add(visual.glowMaterial);
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        if (!sharedTileGeometries.has(object.geometry)) geometries.add(object.geometry);
        const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of meshMaterials) {
          if (!sharedTileMaterials.has(material)) materials.add(material);
        }
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      for (const template of loadedTemplates.values()) disposePieceResources(template);
      stoneColorTexture.dispose();
      stoneBumpTexture.dispose();
      exitHaloTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      cellVisuals.clear();
      pieceModels.clear();
      cellVisualsRef.current = new Map();
      pieceModelsRef.current = new Map();
      pieceAnimationsRef.current.clear();
      for (const animation of exitAnimationsRef.current.values()) {
        animation.ring.geometry.dispose();
        animation.ring.material.dispose();
        animation.materials.forEach((material) => material.dispose());
      }
      exitAnimationsRef.current.clear();
      exitSeamsRef.current.clear();
    };
  }, [game.game_id, game.board_size]);

  useEffect(() => {
    const canvas = hostRef.current?.querySelector("canvas");
    if (!canvas) return;
    canvas.style.visibility = pieceModelsReady ? "visible" : "hidden";
    if (pieceModelsReady) renderRequestRef.current?.(true);
  }, [pieceModelsReady]);

  useEffect(() => {
    const exitRow = game.my_color === "WHITE" ? game.board_size - 1 : 0;
    for (const [row, seam] of exitSeamsRef.current) {
      seam.visible = row === exitRow;
    }
    renderRequestRef.current?.();
  }, [game.my_color, game.board_size, game.game_id]);

  useEffect(() => {
    const group = routeVisualRef.current;
    if (!group) return;
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
    group.clear();
    renderRequestRef.current?.();
    const piece = game.pieces.find((candidate) => candidate.id === selectedPieceId);
    if (!piece?.position || routePath.length === 0) return;

    const half = (game.board_size - 1) / 2;
    const tint = routeIsAttack ? "#db8a72" : "#9bcfe0";
    const positions = [piece.position, ...routePath].map((position) => new THREE.Vector3(
      position.col - half,
      (game.heights[position.row]?.[position.col] ?? 1) * UNIT_HEIGHT + 0.12,
      position.row - half,
    ));
    for (let index = 0; index < positions.length - 1; index += 1) {
      const start = positions[index];
      const end = positions[index + 1];
      const direction = end.clone().sub(start);
      const length = direction.length();
      if (!length) continue;
      const curve = new THREE.LineCurve3(start, end);
      const glow = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 1, 0.055, 7, false),
        new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.22, depthWrite: false }),
      );
      const shaft = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 1, 0.018, 6, false),
        new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.95, depthWrite: false }),
      );
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.075, 0.2, 8),
        new THREE.MeshBasicMaterial({ color: tint, depthWrite: false }),
      );
      arrow.position.copy(end).addScaledVector(direction.normalize(), -Math.min(0.12, length * 0.18));
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
      group.add(glow, shaft, arrow);
    }
    renderRequestRef.current?.();
  }, [game.board_size, game.heights, game.pieces, routeIsAttack, routePath, selectedPieceId]);

  useEffect(() => {
    const previousGame = previousGameRef.current;
    previousGameRef.current = game;
    for (const [key, visual] of cellVisualsRef.current) {
      applyCellIndicator(key, visual, latestProps.current);
    }
    for (const piece of game.pieces) {
      const model = pieceModelsRef.current.get(piece.id);
      if (!model) continue;
      const previousPiece = previousGame?.game_id === game.game_id
        ? previousGame.pieces.find((candidate) => candidate.id === piece.id)
        : undefined;
      if (piece.finished && previousPiece && !previousPiece.finished && previousPiece.position) {
        const startPosition = model.position.clone();
        const materials: THREE.Material[] = [];
        model.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const originals = Array.isArray(object.material) ? object.material : [object.material];
          const clones = originals.map((material) => {
            const clone = material.clone();
            clone.transparent = true;
            clone.depthWrite = false;
            materials.push(clone);
            return clone;
          });
          object.material = Array.isArray(object.material) ? clones : clones[0];
        });
        const ringMaterial = new THREE.MeshBasicMaterial({
          color: 0xfff3d7,
          transparent: true,
          opacity: 0.65,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.018, 8, 48), ringMaterial);
        ring.rotation.x = Math.PI / 2;
        ring.position.copy(startPosition);
        ring.position.y += 0.025;
        model.parent?.add(ring);
        model.visible = true;
        pieceAnimationsRef.current.delete(piece.id);
        exitAnimationsRef.current.set(piece.id, {
          startedAt: performance.now(),
          startPosition,
          materials,
          ring,
        });
        continue;
      }
      if (exitAnimationsRef.current.has(piece.id)) continue;
      if (!piece.position || piece.captured || piece.finished) {
        model.visible = false;
        continue;
      }
      model.visible = true;
      const target = new THREE.Vector3(
        piece.position.col - (game.board_size - 1) / 2,
        (game.heights[piece.position.row]?.[piece.position.col] ?? 1) * UNIT_HEIGHT,
        piece.position.row - (game.board_size - 1) / 2,
      );
      const previousTarget = model.userData.visualTarget as THREE.Vector3 | undefined;
      if (!previousTarget || previousTarget.distanceToSquared(target) > 0.0001) {
        const positionChanged = Boolean(
          previousPiece?.position && piece.position &&
          (previousPiece.position.row !== piece.position.row || previousPiece.position.col !== piece.position.col),
        );
        const legalPath = positionChanged && previousGame
          ? getLocalLegalPaths(previousGame, piece.id).find((candidate) =>
            candidate.destination.row === piece.position!.row &&
            candidate.destination.col === piece.position!.col,
          )
          : undefined;
        const override = movementPathOverride?.pieceId === piece.id
          ? movementPathOverride
          : null;
        const route = override
          ? override.special === "double_jump"
            ? override.path.slice(-1)
            : override.path
          : legalPath
          ? legalPath.special === "double_jump"
            ? [legalPath.destination]
            : legalPath.path
          : piece.position ? [piece.position] : [];
        const points = [model.position.clone(), ...route.map((position) => new THREE.Vector3(
          position.col - (game.board_size - 1) / 2,
          (game.heights[position.row]?.[position.col] ?? 1) * UNIT_HEIGHT,
          position.row - (game.board_size - 1) / 2,
        ))];
        pieceAnimationsRef.current.set(piece.id, {
          points: points.length > 1 ? points : [model.position.clone(), target],
          startedAt: performance.now(),
        });
        model.userData.visualTarget = target.clone();
      }
      model.userData.row = piece.position.row;
      model.userData.col = piece.position.col;
    }
    renderRequestRef.current?.(pieceAnimationsRef.current.size > 0 || exitAnimationsRef.current.size > 0);
  }, [game, hideIndicators, selectedPieceId, legalDestinations, attackablePieceIds, insufficientAttackPieceIds, movementPathOverride]);

  return (
    <div ref={hostRef} className="game-board-3d" aria-busy={!pieceModelsReady}>
      {!pieceModelsReady && (
        <div className="piece-model-loading" role="status" aria-live="polite">
          <span className="piece-model-spinner" aria-hidden="true" />
          <strong>Préparation du plateau 3D</strong>
          <span>Chargement des pièces : {currentLoadProgress.settled} / {PIECE_MODEL_COUNT}</span>
          {currentLoadProgress.failed > 0 && (
            <small>{currentLoadProgress.failed} modèle(s) indisponible(s), affichage provisoire en cours.</small>
          )}
        </div>
      )}
    </div>
  );
}
