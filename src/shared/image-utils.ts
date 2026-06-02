import type { UploadItem } from '../api/contracts/policy';

export const MAX_POLICY_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_OCR_IMAGE_DIMENSION = 3600;
export const OCR_IMAGE_JPEG_QUALITY = 0.96;
export const OCR_IMAGE_DIRECT_UPLOAD_BYTES = 8 * 1024 * 1024;

export type ClientPerformanceTimings = {
  fileReadMs?: number;
  imageDecodeMs?: number;
  imageCompressMs?: number;
};

export function clientPerfNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export function clientElapsedMs(startedAt: number) {
  return Math.max(0, Math.round(clientPerfNow() - startedAt));
}

export async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

export function dataUrlByteSize(dataUrl: string) {
  const payload = String(dataUrl || '').split(',')[1] || '';
  return Math.round((payload.length * 3) / 4);
}

export async function compressImageForOcr(file: File, timings: ClientPerformanceTimings = {}): Promise<UploadItem | null> {
  if (!file.type.startsWith('image/')) return null;
  const readStartedAt = clientPerfNow();
  const originalDataUrl = await readFileAsDataUrl(file);
  timings.fileReadMs = clientElapsedMs(readStartedAt);
  const decodeStartedAt = clientPerfNow();
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const node = new Image();
    node.onload = () => resolve(node);
    node.onerror = () => reject(new Error('图片解析失败'));
    node.src = originalDataUrl;
  });
  timings.imageDecodeMs = clientElapsedMs(decodeStartedAt);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const maxDimension = Math.max(width, height);
  if (!width || !height || (maxDimension <= MAX_OCR_IMAGE_DIMENSION && file.size <= OCR_IMAGE_DIRECT_UPLOAD_BYTES)) {
    return {
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: originalDataUrl,
    };
  }
  const scale = Math.min(1, MAX_OCR_IMAGE_DIMENSION / maxDimension);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    return {
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: originalDataUrl,
    };
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(image, 0, 0, targetWidth, targetHeight);
  const compressStartedAt = clientPerfNow();
  const dataUrl = canvas.toDataURL('image/jpeg', OCR_IMAGE_JPEG_QUALITY);
  timings.imageCompressMs = clientElapsedMs(compressStartedAt);
  return {
    name: file.name.replace(/\.[^.]+$/, '') || file.name,
    type: 'image/jpeg',
    size: dataUrlByteSize(dataUrl),
    dataUrl,
  };
}

export async function fileToUploadItem(file: File, timings: ClientPerformanceTimings = {}): Promise<UploadItem> {
  const compressed = await compressImageForOcr(file, timings).catch(() => null);
  if (compressed) return compressed;
  const readStartedAt = clientPerfNow();
  const dataUrl = await readFileAsDataUrl(file);
  timings.fileReadMs = timings.fileReadMs || clientElapsedMs(readStartedAt);
  return {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    dataUrl,
  };
}
