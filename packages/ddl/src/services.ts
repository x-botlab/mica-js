import {
  createDefaultCoreModule,
  createDefaultSharedCoreModule,
  EmptyFileSystem,
  inject,
  type DefaultSharedCoreModuleContext,
  type LangiumCoreServices,
  type LangiumSharedCoreServices,
} from 'langium';
import { DDLGeneratedModule, DDLGeneratedSharedModule } from './generated/module.js';

/** Core-only services keep the parser usable without Node.js or a language server. */
export function createDDLServices(context: DefaultSharedCoreModuleContext = EmptyFileSystem): {
  shared: LangiumSharedCoreServices;
  DDL: LangiumCoreServices;
} {
  const shared = inject(createDefaultSharedCoreModule(context), DDLGeneratedSharedModule);
  const DDL = inject(createDefaultCoreModule({ shared }), DDLGeneratedModule);
  shared.ServiceRegistry.register(DDL);
  return { shared, DDL };
}
