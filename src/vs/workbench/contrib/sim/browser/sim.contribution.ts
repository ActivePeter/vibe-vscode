/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileAccess } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ISimHostContext } from '../common/sim.js';
import { SimEditorInput, SimEditorSerializer } from './simEditorInput.js';
import { SimEditorPane } from './simEditorPane.js';
import { SimViewPane } from './simViewPane.js';
import { ISimWorkbenchService, SimWorkbenchService } from './simWorkbenchService.js';

registerSingleton(ISimWorkbenchService, SimWorkbenchService, InstantiationType.Delayed);

const simIcon = FileAccess.asBrowserUri('vs/workbench/contrib/sim/browser/media/sim.svg');
const containerId = 'workbench.view.extension.vibe-vscode-sim';
const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: containerId,
	title: localize2('sim.containerTitle', "Sim"),
	icon: simIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [containerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: containerId,
	hideIfEmpty: true,
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: 'vibe-vscode.sim.sidebar',
	name: localize2('sim.viewTitle', "Sim"),
	containerIcon: simIcon,
	ctorDescriptor: new SyncDescriptor(SimViewPane),
	canMoveView: true,
	canToggleVisibility: false,
}], container);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(SimEditorPane, SimEditorPane.ID, localize('sim.editorPane', "Sim")),
	[new SyncDescriptor(SimEditorInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(SimEditorInput.ID, SimEditorSerializer);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe-vscode.openSim',
			title: localize2('sim.open', "Open Sim"),
			category: { value: 'vibe vscode', original: 'vibe vscode' },
			f1: true,
			menu: { id: MenuId.MenubarViewMenu, group: '1_vibe' },
		});
	}
	run(accessor: ServicesAccessor, path?: unknown): Promise<void> {
		return accessor.get(ISimWorkbenchService).openEditor(path);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'vibe-vscode.openSimFullscreen', title: localize2('sim.openFullscreen', "Open Sim Fullscreen"), category: { value: 'vibe vscode', original: 'vibe vscode' }, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(ISimWorkbenchService).openEditor(undefined, true);
	}
});

CommandsRegistry.registerCommand('vibe-vscode.openFullscreenPanel', accessor => accessor.get(ISimWorkbenchService).openEditor(undefined, true));
CommandsRegistry.registerCommand('vibe-vscode.closeFullscreenPanel', accessor => accessor.get(ISimWorkbenchService).closeFullscreen());
CommandsRegistry.registerCommand('_vibe-vscode.sim.updateContext', (accessor, context: ISimHostContext) => accessor.get(ISimWorkbenchService).updateContext(context));

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibe-vscode.sim',
	title: 'Sim',
	properties: {
		'vibe-vscode.sim.baseUrl': {
			type: 'string',
			default: '',
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('sim.baseUrl', "Same-origin Sim gateway URL. Leave empty to use the Vibe VS Code origin and its login. Cross-origin URLs are not supported by the hosted Sim surface."),
		},
	},
});
