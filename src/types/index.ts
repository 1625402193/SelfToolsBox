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
  // 快速探测文件夹下各扩展名的文件数量（只读目录项，不做 stat，用于大文件夹的类型筛选面板）
  mediaScanExtensions: (dirPath: string, options?: { includeSubfolders?: boolean }) =>
    Promise<{ success: boolean; data?: Record<string, number>; error?: string }>;
  // extensions 不传或为空时扫描全部识别的媒体类型；传入时只扫描选中的类型（未选中的完全不参与，性能更好）
  mediaScan: (dirPath: string, options?: { includeSubfolders?: boolean; extensions?: string[] }) =>
    Promise<{ success: boolean; data?: MediaItem[]; error?: string }>;
  mediaLoadRatings: (dirPath: string) => Promise<{ success: boolean; data?: Record<string, number>; error?: string }>;
  mediaSaveRatings: (dirPath: string, ratings: Record<string, number>) => Promise<{ success: boolean; error?: string }>;
  mediaExportByRating: (
    files: { path: string; name: string; relativePath?: string; ratingLabel?: string }[],
    targetPath: string,
    isCopyMode: boolean,
    groupByRating: boolean,
    separateByType?: boolean,
  ) => Promise<{ success: boolean; data?: { successCount: number; failCount: number; errors: string[] }; error?: string }>;
  mediaDeleteFile: (filePath: string, toTrash?: boolean) => Promise<{ success: boolean; error?: string }>;
  mediaDeleteFiles: (paths: string[], toTrash?: boolean) =>
    Promise<{ success: boolean; data?: { successCount: number; failCount: number; errors: string[] }; error?: string }>;
  // 查找与给定文件同目录、同基础名（不含扩展名）但类型不同的媒体文件（如 5099.jpg 对应的 5099.arw）
  mediaFindSiblings: (rootDir: string, items: { dir: string; baseName: string }[]) =>
    Promise<{ success: boolean; data?: Record<string, MediaSiblingFile[]>; error?: string }>;

  // 批量复制图片
  imageCopyBuildIndex: (targetPaths: string[], options?: ImageCopyOptions) =>
    Promise<{ success: boolean; data?: ImageIndexData; error?: string }>;
  imageCopyLoadIndex: (targetPaths?: string[]) => Promise<{ success: boolean; data?: ImageIndexData; error?: string }>;
  imageCopyScanSources: (sourcePaths: string[], options?: ImageCopyOptions) =>
    Promise<{ success: boolean; data?: ImageScanData; error?: string }>;
  imageCopyMakePlan: (options?: { excludePaths?: string[] } & ImageMatchOptions) =>
    Promise<{ success: boolean; data?: ImageCopyPlan; error?: string }>;
  imageCopyCheckConflicts: (options: { choices?: Record<string, string>; unmatchedFolderName?: string; skipSameContent?: boolean }) =>
    Promise<{ success: boolean; data?: { total: number; conflicts: ImageConflict[]; sameContentCount?: number; unmatchedDirs?: Record<string, string> }; error?: string }>;
  imageCopyExecute: (options: {
    choices?: Record<string, string>;
    overwriteMode?: 'overwrite' | 'skip' | 'decide';
    decisions?: Record<string, boolean>;
    skipSameContent?: boolean;
    unmatchedFolderName?: string;
  }) => Promise<{ success: boolean; data?: ImageCopyResult; error?: string }>;
  imageCopyReadLog: (limit?: number) =>
    Promise<{ success: boolean; data?: { logPath: string; entries: ImageCopyLogEntry[]; total?: number }; error?: string }>;
  imageCopyAppendLog: (entry: Partial<ImageCopyLogEntry>) => Promise<{ success: boolean }>;
  imageCopyClearLog: () => Promise<{ success: boolean; error?: string }>;
}

interface ImageCopyOptions {
  recursive?: boolean;
  oddSizeFolderName?: string;
  unmatchedFolderName?: string;
  /** 是否把尺寸异常的图片额外复制一份到「尺寸异常」文件夹备查 */
  copyOddSizeToFolder?: boolean;
  /** 后缀分类词（如 Fang/Yuan），命中时优先定位到同前缀且同后缀的目录 */
  suffixWords?: string[];
  /** 前缀回退时允许的最短分段数 */
  minSegments?: number;
}

/** 匹配方式：exact 同名 / suffix 后缀词 / prefix 前缀 / size 尺寸 / none 未命中 */
type ImageMatchVia = 'exact' | 'suffix' | 'prefix' | 'size' | 'none';

interface ImageMatchOptions {
  enableExactName?: boolean;
  enableSuffixMatch?: boolean;
  enablePrefixMatch?: boolean;
  enableSizeFallback?: boolean;
  preferMostFiles?: boolean;
  suffixWords?: string[];
  minSegments?: number;
}

/** 目标路径下某个子目录的图片分布，用于界面展示 */
interface ImageDirStat {
  dir: string;
  relativeDir: string;
  fileCount: number;
  resolutions: { res: string; count: number }[];
}

/** 单个目标路径的索引摘要：多个目标路径彼此独立，各有一份 */
interface ImageRootIndex {
  root: string;
  updatedAt: string;
  indexFile: string;
  /** 尺寸索引的文件路径（单独存放） */
  sizeIndexFile?: string;
  stats: {
    imageCount: number;
    dirCount: number;
    nameKeyCount?: number; prefixKeyCount?: number; suffixKeyCount?: number;
    sizeKeyCount?: number; sizedImageCount?: number; multiDirSizeKeyCount?: number;
  };
  /** 各子目录的图片数与分辨率分布 */
  dirStats: ImageDirStat[];
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
  root?: string;
  width: number | null;
  height: number | null;
  sizeUnknown?: boolean;
  /** 宽高非 2 的倍数。不强制剔除，是否复制由用户选择 */
  oddSized?: boolean;
}

interface ImageScanData {
  scannedAt: string;
  missing: string[];
  total: number;
  pending: number;
  oddSizeFolder: string | null;
  /** 合并后待处理的图片（平铺，不再按分类键分组） */
  files: ImageScanFile[];
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
  candidates?: { dir: string; sampleCount: number; resolutions?: string[] }[];
  /** 匹配来源 */
  via?: ImageMatchVia;
}

/** 单个目标路径的复制计划 */
interface ImageRootPlan {
  root: string;
  direct: ImagePlanGroup[];
  ambiguous: ImagePlanGroup[];
  unmatched: ImagePlanGroup[];
  /** 各匹配方式命中的图片数量 */
  viaCount?: Partial<Record<ImageMatchVia, number>>;
  /** 由分辨率自动消歧确定的图片数量 */
  autoResolvedCount?: number;
}

interface ImageCopyPlan {
  roots: ImageRootPlan[];
  /** 按用户选择被排除、不复制的图片数量 */
  excludedCount?: number;
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
  via?: ImageMatchVia;
}

interface ImageCopyRootResult {
  root: string;
  copied: number;
  overwritten: number;
  skipped: number;
  sameContent?: number;
  failed: number;
}

interface ImageCopyResult {
  total: number;
  copied: number;
  overwritten: number;
  skipped: number;
  /** 同名且内容一致，自动跳过的数量 */
  sameContent?: number;
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

/** 同目录下与某文件同基础名但扩展名不同的媒体文件（如 5099.jpg 对应的 5099.arw） */
interface MediaSiblingFile {
  name: string;
  path: string;
  relativePath: string;
  extension: string;
  type: 'image' | 'video';
  size: number;
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
  ElectronAPI, ClassifyGroup, FileItem, MediaItem, MediaSiblingFile,
  ImageCopyOptions, ImageMatchOptions, ImageMatchVia,
  ImageDirStat, ImageRootIndex, ImageIndexData, ImageScanFile,
  ImageScanData, ImagePlanGroup, ImageRootPlan, ImageCopyPlan, ImageConflict,
  ImageCopyRootResult, ImageCopyResult, ImageCopyLogEntry,
};
