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

export type { ElectronAPI, ClassifyGroup, FileItem, MediaItem };
