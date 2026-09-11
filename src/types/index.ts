/// <reference types="vite/client" />

interface ElectronAPI {
  openDirectory: () => Promise<string | null>;
  readDir: (dirPath: string, options?: { recursive?: boolean; includeFiles?: boolean; includeDirs?: boolean }) => Promise<{ success: boolean; data?: any[]; error?: string }>;
  classifyFiles: (dirPath: string, options?: { useCreationTime?: boolean; includeSubfolders?: boolean }) => Promise<{ success: boolean; data?: { totalFiles: number; groups: ClassifyGroup[] }; error?: string }>;
  executeClassify: (targetPath: string, groups: ClassifyGroup[], isCopyMode: boolean) => Promise<{ success: boolean; data?: { successCount: number; failCount: number; errors: string[] }; error?: string }>;
  batchMove: (targetPath: string, files: FileItem[], isCopyMode: boolean, flatten: boolean) => Promise<{ success: boolean; data?: { successCount: number; failCount: number; errors: string[] }; error?: string }>;
  saveFile: (filePath: string, data: string) => Promise<{ success: boolean; error?: string }>;
  saveBuffer: (filePath: string, data: Uint8Array) => Promise<{ success: boolean; size?: number; error?: string }>;
  saveScreenshot: (saveDir: string, dataUrl: string) => Promise<{ success: boolean; filePath?: string; fileName?: string; error?: string }>;
  exportJson: (options: { defaultFileName?: string; content: string }) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
  importJson: () => Promise<{ success: boolean; canceled?: boolean; filePath?: string; content?: string; error?: string }>;
  getCaptureSources: () => Promise<{ id: string; name: string; thumbnail: string }[]>;
  getScreenSourceId: (region?: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean; sourceId?: string; display?: { id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }; error?: string }>;
  selectRegion: () => Promise<{ x: number; y: number; width: number; height: number; previewDataUrl?: string } | null>;
  screenshotRegion: (region: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  showRecordingOverlay: (region: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean; error?: string }>;
  hideRecordingOverlay: () => Promise<{ success: boolean; error?: string }>;
  getScreenBounds: () => Promise<{ width: number; height: number; scaleFactor: number }>;
  configRead: () => Promise<{ success: boolean; data?: Record<string, any>; error?: string }>;
  configWrite: (data: Record<string, any>) => Promise<{ success: boolean; error?: string }>;
  openPath: (filePath: string) => Promise<void>;
  autoClick: (x: number, y: number) => Promise<{ success: boolean; error?: string }>;
  showClickIndicator: (x: number, y: number) => Promise<{ success: boolean }>;
  getMousePos: () => Promise<{ success: boolean; x?: number; y?: number; error?: string }>;
  selectPosition: () => Promise<{ success: boolean; x?: number; y?: number; error?: string }>;
  preventSleep: () => Promise<{ success: boolean }>;
  allowSleep: () => Promise<{ success: boolean }>;
  reportRead: (fileName: string) => Promise<{ success: boolean; data?: string; error?: string }>;
  reportWrite: (fileName: string, content: string) => Promise<{ success: boolean; error?: string }>;
  copyImageToClipboard: (dataUrl: string) => Promise<{ success: boolean; error?: string }>;

  // 窗口置顶
  getAlwaysOnTop: () => Promise<{ success: boolean; enabled: boolean }>;
  setAlwaysOnTop: (enabled: boolean) => Promise<{ success: boolean; enabled?: boolean; error?: string }>;
  onAlwaysOnTopChanged: (callback: (enabled: boolean) => void) => () => void;

  // 应用菜单
  menuSetup: (items: { label: string; route: string }[]) => Promise<{ success: boolean; error?: string }>;
  onMenuNavigate: (callback: (route: string) => void) => () => void;

  // 媒体评分
  mediaScan: (dirPath: string, options?: { includeSubfolders?: boolean }) => Promise<{ success: boolean; data?: MediaItem[]; error?: string }>;
  mediaLoadRatings: (dirPath: string) => Promise<{ success: boolean; data?: Record<string, number>; error?: string }>;
  mediaSaveRatings: (dirPath: string, ratings: Record<string, number>) => Promise<{ success: boolean; error?: string }>;
  mediaExportByRating: (
    files: { path: string; name: string; relativePath?: string }[],
    targetPath: string,
    isCopyMode: boolean,
    groupByRating: boolean,
    ratingMap: Record<string, number>,
  ) => Promise<{ success: boolean; data?: { successCount: number; failCount: number; errors: string[] }; error?: string }>;
  mediaDeleteFile: (filePath: string, toTrash?: boolean) => Promise<{ success: boolean; error?: string }>;

  // 批量复制图片
  imageCopyBuildIndex: (targetPaths: string[], options?: ImageCopyOptions) =>
    Promise<{ success: boolean; data?: ImageIndexData; error?: string }>;
  imageCopyLoadIndex: (targetPaths?: string[]) => Promise<{ success: boolean; data?: ImageIndexData; error?: string }>;
  imageCopyScanSources: (sourcePaths: string[], options?: ImageCopyOptions) =>
    Promise<{ success: boolean; data?: ImageScanData; error?: string }>;
  imageCopyMakePlan: () => Promise<{ success: boolean; data?: ImageCopyPlan; error?: string }>;
  imageCopyCheckConflicts: (options: { choices?: Record<string, string>; unmatchedFolderName?: string }) =>
    Promise<{ success: boolean; data?: { total: number; conflicts: ImageConflict[]; unmatchedDirs?: Record<string, string> }; error?: string }>;
  imageCopyExecute: (options: {
    choices?: Record<string, string>;
    overwriteMode?: 'overwrite' | 'skip' | 'decide';
    decisions?: Record<string, boolean>;
    unmatchedFolderName?: string;
  }) => Promise<{ success: boolean; data?: ImageCopyResult; error?: string }>;
  imageCopyReadLog: (limit?: number) =>
    Promise<{ success: boolean; data?: { logPath: string; entries: ImageCopyLogEntry[]; total?: number }; error?: string }>;
  imageCopyAppendLog: (entry: Partial<ImageCopyLogEntry>) => Promise<{ success: boolean }>;
  imageCopyClearLog: () => Promise<{ success: boolean; error?: string }>;
}

interface ImageCopyOptions {
  keySegments?: number;
  genericPrefixes?: string[];
  recursive?: boolean;
  oddSizeFolderName?: string;
  unmatchedFolderName?: string;
}

interface ImageIndexEntry {
  key: string;
  display: string;
  dirCount: number;
  fileCount: number;
  dirs: string[];
}

/** 单个目标路径的索引摘要：多个目标路径彼此独立，各有一份 */
interface ImageRootIndex {
  root: string;
  updatedAt: string;
  indexFile: string;
  stats: { keyCount: number; dirCount: number; imageCount: number; multiDirKeyCount: number };
  entries: ImageIndexEntry[];
}

interface ImageIndexData {
  exists: boolean;
  indexDir: string;
  missing?: string[];
  roots: ImageRootIndex[];
}

interface ImageScanFile {
  name: string;
  path: string;
  width: number | null;
  height: number | null;
  sizeUnknown?: boolean;
}

interface ImageScanGroup {
  key: string;
  display: string;
  fileCount: number;
  files: ImageScanFile[];
}

interface ImageScanData {
  scannedAt: string;
  missing: string[];
  total: number;
  pending: number;
  oddSizeFolder: string | null;
  groups: ImageScanGroup[];
  oddSized: { name: string; path: string; width: number | null; height: number | null }[];
  unknownSize: { name: string; path: string }[];
  duplicates: { name: string; dropped: string; kept: string }[];
  logs: ImageCopyLogEntry[];
}

interface ImagePlanGroup {
  key: string;
  display: string;
  fileCount: number;
  fileNames: string[];
  targetDir?: string;
  candidates?: { dir: string; sampleCount: number }[];
}

/** 单个目标路径的复制计划 */
interface ImageRootPlan {
  root: string;
  direct: ImagePlanGroup[];
  ambiguous: ImagePlanGroup[];
  unmatched: ImagePlanGroup[];
}

interface ImageCopyPlan {
  roots: ImageRootPlan[];
}

interface ImageConflict {
  root: string;
  key: string;
  display: string;
  name: string;
  src: string;
  destPath: string;
  existSize: number;
  existTime: string;
}

interface ImageCopyRootResult {
  root: string;
  copied: number;
  overwritten: number;
  skipped: number;
  failed: number;
}

interface ImageCopyResult {
  total: number;
  copied: number;
  overwritten: number;
  skipped: number;
  failed: number;
  unmatchedDirs: Record<string, string>;
  perRoot: ImageCopyRootResult[];
  logs: ImageCopyLogEntry[];
}

interface ImageCopyLogEntry {
  time?: string;
  action: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  detail?: Record<string, any>;
}

interface MediaItem {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  extension: string;
  type: 'image' | 'video';
  modifyTime: string;
}

interface ClassifyGroup {
  date: string;
  type: string;
  files: FileItem[];
}

interface FileItem {
  name: string;
  path: string;
  isDirectory?: boolean;
  size?: number;
  extension?: string;
  date?: string;
  createTime?: string;
  modifyTime?: string;
  relativeDir?: string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export type {
  ElectronAPI, ClassifyGroup, FileItem, MediaItem,
  ImageCopyOptions, ImageIndexEntry, ImageRootIndex, ImageIndexData, ImageScanFile, ImageScanGroup,
  ImageScanData, ImagePlanGroup, ImageRootPlan, ImageCopyPlan, ImageConflict,
  ImageCopyRootResult, ImageCopyResult, ImageCopyLogEntry,
};
