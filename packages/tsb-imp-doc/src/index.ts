import type { ProjectInitializer } from '@spyglassmc/core'
import { declaration as bindDeclaration } from './binder/declaration.js'
import { impDoc as bindImpDoc } from './binder/impDoc.js'
import { mcfunction as bindMcfunction } from './binder/mcfunction.js'
import { impDoc as checkImpDoc } from './checker/impDoc.js'
import { registerVisibilityCompleters } from './completer/visibility.js'
import { configValidator, privateVisibility } from './linter/private.js'
import type { ImpDocDeclarationNode, ImpDocNode } from './node/ImpDocNode.js'
import { extendMcfunctionParser, impDoc } from './parser/impDoc.js'
import { ImpDocVersion } from './version.js'

export * from './node/ImpDocNode.js'
export * from './parser/impDoc.js'
export * from './util/withinPattern.js'
export { ImpDocVersion } from './version.js'

export const initialize: ProjectInitializer = ({ meta }) => {
	const mcfunction = meta.getLanguageOptions('mcfunction')
	if (!mcfunction?.parser) {
		throw new Error(
			'[tsb-imp-doc] mcfunction must be initialized before tsb-imp-doc',
		)
	}

	// parser-only な CLI (= tsb-imp-doc-cli) は completer を登録しないので
	// wrapper もスキップ。 Language Server 経路では je.initialize 後に本
	// initialize が呼ばれるため、 3 completer が揃う。
	if (mcfunction.completer) {
		registerVisibilityCompleters(meta)
	}

	meta.registerParser<ImpDocNode>('impDoc', impDoc)
	meta.registerBinder<ImpDocNode>('impDoc', bindImpDoc)
	meta.registerBinder('mcfunction:entry', bindMcfunction)
	meta.registerBinder<ImpDocDeclarationNode>(
		'impDoc:declaration',
		bindDeclaration,
	)
	meta.registerChecker<ImpDocNode>('impDoc', checkImpDoc)
	meta.registerLinter('impDocPrivate', {
		configValidator,
		linter: privateVisibility,
		nodePredicate: node => node.type === 'file',
	})

	meta.registerLanguage('mcfunction', {
		...mcfunction,
		parser: extendMcfunctionParser(mcfunction.parser),
	})

	return {
		'plugin:@spyglassmc/tsb-imp-doc': ImpDocVersion,
	}
}
