export {
  createFileService,
  FileService,
  type FileServiceOptions,
  type FileReference,
} from "./service.ts";
export {
  createFileMount,
  fileScopeFor,
  type FileMount,
  type FileMountOptions,
} from "./http.ts";
export { registerFileTool, type FileToolOptions } from "./tool.ts";
export {
  FileError,
  FileValidationError,
  type FileErrorCode,
} from "./errors.ts";
export type { UploadedFile, ToolFileContext, FileValidator } from "./handle.ts";
export {
  MCPP_FILES_EXTENSION,
  FILE_ID_PATTERN,
  FILES_VERSION,
  type FileScope,
  type FilesCapability,
  type UploadedFileInfo,
} from "./protocol.ts";
