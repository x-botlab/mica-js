import { createDecorator } from './instantiation';
import type {
  IDeviceLibrary as IDeviceLibraryContract,
  IFileSystemProvider as IFileSystemProviderContract,
  IWidgetLibrary as IWidgetLibraryContract,
} from './providers';

export type IDeviceLibrary = IDeviceLibraryContract;
export const IDeviceLibrary = createDecorator<IDeviceLibrary>('editor.deviceLibrary');

export type IWidgetLibrary = IWidgetLibraryContract;
export const IWidgetLibrary = createDecorator<IWidgetLibrary>('editor.widgetLibrary');

export type IFileSystemProvider = IFileSystemProviderContract;
export const IFileSystemProvider = createDecorator<IFileSystemProvider>(
  'editor.fileSystemProvider',
);
