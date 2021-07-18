import { ast } from 'pico8parse';
import { Range } from 'vscode-languageserver-textdocument';
import { Diagnostic, DiagnosticSeverity, DocumentSymbol, InitializeError } from 'vscode-languageserver';
import { aug } from './augmented';
import { LuaType, resolve } from './typing';

export type RangeLUT = { [name: string]: {
	range: Range,
	name: string,
	type: LuaType,
	info: any,
} }

type LuaVariable = {
	// every expression that were assigned to it, last in first
	values: aug.Expression[]
}
type Scope = {
	labels: Record<string, Range | undefined>,
	variables: Record<string, LuaVariable | undefined>,
}
type Loc = ast.Node['loc']

function locToRange(loc: Loc): Range {
	const { start, end } = loc ?? { start: {line:1,column:0}, end: {line:1,column:0}, };
	return {
		start: {
			line: start.line-1,
			character: start.column,
		},
		end: {
			line: end.line-1,
			character: end.column,
		},
	};
}

type TTypes = ast.Node['type'];

// @thx https://stackoverflow.com/a/64469734/13196480
type FindByTType<Union, TType> = Union extends { type: TType } ? Union : never;
type NodeHandler = { [TType in TTypes]: (node: FindByTType<ast.Node, TType>) => void }

export class SelfExplore {
	protected ast: ast.Chunk = { type: 'Chunk', body: [] };
	protected symbols: DocumentSymbol[] = [];

	protected clear() {
		this.ast = { type: 'Chunk', body: [] };
		this.diagnostics = [];
		this.symbols = [];
		this.ranges = {};
		this.globalScope = { labels: {}, variables: {}, };
		this.contextStack = [];
	}

	private handlers: NodeHandler;

	protected explore() {
		this.handlers.Chunk(this.ast);
	}

	protected ranges: RangeLUT = {};

	private locate(name: string, range: Range) {
		console.log("Locating " + name + " @" + JSON.stringify(range));
		const val = this.lookup(name);
		this.ranges[`:${range.start.line}:${range.start.character}`] = {
			range,
			name,
			type: val ? resolve(val[0]) : 'nil', // XXX
			info: val
		};
		return range;
	}

//#region diagnostics
	protected diagnostics: Diagnostic[] = [];

	warning(message: string, range: Range) {
		this.diagnostics.push({
			message,
			range,
			severity: DiagnosticSeverity.Warning,
		});
	}

	error(message: string, range: Range) {
		this.diagnostics.push({
			message,
			range,
			severity: DiagnosticSeverity.Error,
		});
	}
//#endregion

//#region scopes
	protected globalScope: Scope = { labels: {}, variables: {}, };
	protected currentScope!: Scope;

	private fork(): Scope {
		console.log("Forking from current scope");
		const previousScope = this.currentScope;
		this.currentScope = {
			labels: Object.create(this.currentScope.labels),
			variables: Object.create(this.currentScope.variables),
		};
		return previousScope;
	}

	private restore(previousScope: Scope) {
		console.log("Closing and restoring scope");
		this.currentScope = previousScope;
	}

	private declare(name: string, value: aug.Expression) {
		// console.log("Declaring value for " + name);
		if (!Object.prototype.hasOwnProperty.call(this.currentScope.variables, name)) {
			// console.log("\tas shadowing");
			// console.log("\t" + this.currentScope.variables[name]);
			this.currentScope.variables[name] = { values: [value] };
		} else {
			// console.log("\tas updating");
			// console.log("\t" + this.currentScope.variables[name]);
			this.currentScope.variables[name]!.values.push(value);
		}
	}

	private lookup(name: string) {
		// console.log("Looking up " + name);
		return this.currentScope.variables[name]?.values;
	}
//#endregion

//#region context
	private contextStack: aug.Node[] = [];

	private contextPush(node: ast.Node) {
		this.contextStack.unshift(node as aug.Node);
	}

	private contextFind<TType extends TTypes>(type: TType) {
		return this.contextStack.find(it => type === it.type) as FindByTType<aug.Node, TType> | undefined;
	}

	private contextPeek() {
		return this.contextStack[0];
	}

	private contextPop(expectedType: TTypes) {
		const got = this.contextStack.shift();
		if (expectedType !== got?.type)
			throw Error(`Expecting state to have a ${expectedType}, found ${got?.type}`);
	}
//#endregion

//#region handlers
	constructor() {
		this.handlers = {
			Chunk: node => {
				this.contextPush(node);
				this.currentScope = this.globalScope;
				node.body.forEach(it => this.handlers[it.type](it as any));
				this.contextPop('Chunk');
			},

			Comment: (node) => { void 0; },

			Identifier: node => {
				const augmented = node as aug.Identifier;
				if (augmented.augValue) {
					this.declare(augmented.name, augmented.augValue);
				} else {
					augmented.augValue = this.lookup(augmented.name)?.[0];
				}
				this.locate(node.name, locToRange(node.loc));
			},

			FunctionDeclaration: (node) => {
				this.contextPush(node);
				const previousScope = this.fork();
				node.parameters.forEach(it => {
					(it as aug.Identifier).augValue = 'unknown' as any;
					this.handlers[it.type](it as any);
				});
				node.body.forEach(it => this.handlers[it.type](it as any));
				this.restore(previousScope);
				this.contextPop('FunctionDeclaration');

				if (node.identifier) {
					if (node.identifier.type === 'Identifier') {
						const augmented = node.identifier as aug.Identifier;
						augmented.augValue = node as aug.FunctionDeclaration;
					}
					this.handlers[node.identifier.type](node.identifier as any);
				} else {
					(node as aug.FunctionDeclaration).augValue = node;
				}
			},

		//#region statements
			LabelStatement: ({ label, loc }) => {
				const range = locToRange(loc);
				if (Object.prototype.hasOwnProperty.call(this.currentScope.labels, label.name)) {
					const previous = this.currentScope.labels[label.name];
					this.warning("label already defined line " + previous?.start.line, range);
				} else {
					this.currentScope.labels[label.name] = range;
				}
			},

			BreakStatement: (node) => { void 1; },

			GotoStatement: ({ label, loc }) => {
				if (!Object.prototype.hasOwnProperty.call(this.currentScope.labels, label.name))
					this.warning("label not defined", locToRange(loc));
				else {
					const range = locToRange(label.loc);
					this.ranges[`:${range.start.line}:${range.start.character}`] = {
						range,
						name: label.name,
						type: "line " + this.currentScope.labels[label.name]?.start.line as any,
						info: null
					};
				}
			},

			ReturnStatement: (node) => {
				const fun = this.contextFind('FunctionDeclaration');
				if (!fun) {
					this.error("no function to return from", locToRange(node.loc));
					return;
				}
				if (!fun.augReturns) fun.augReturns = [];
				node.arguments.forEach(it => this.handlers[it.type](it as any));
				fun.augReturns.push(node);
			},

			IfStatement: (node) => {
				this.contextPush(node);
					node.clauses.forEach(it => this.handlers[it.type](it as any));
				this.contextPop('IfStatement');
			},

			WhileStatement: (node) => {
				this.contextPush(node);
					this.handlers[node.condition.type](node.condition as any);

					const previousScope = this.fork();
						node.body.forEach(it => this.handlers[it.type](it as any));
					this.restore(previousScope);
				this.contextPop('WhileStatement');
			},

			DoStatement: (node) => {
				this.contextPush(node);
					const previousScope = this.fork();
						node.body.forEach(it => this.handlers[it.type](it as any));
					this.restore(previousScope);
				this.contextPop('DoStatement');
			},

			RepeatStatement: (node) => {
				this.contextPush(node);
					const previousScope = this.fork();
						node.body.forEach(it => this.handlers[it.type](it as any));
					this.restore(previousScope);

					this.handlers[node.condition.type](node.condition as any);
				this.contextPop('RepeatStatement');
			},

			LocalStatement: (node) => {
				const types = node.init.flatMap(it => {
					this.handlers[it.type](it as any);
					const augmented = it as aug.Expression;
					switch (augmented.type) {
						case 'CallExpression':
						case 'TableCallExpression':
						case 'StringCallExpression':
							return augmented.augValues ?? [];
						case 'Identifier':
						case 'NilLiteral':
						case 'NumericLiteral':
						case 'BooleanLiteral':
						case 'StringLiteral':
						case 'VarargLiteral':
						case 'FunctionDeclaration':
						// case 'BinaryExpression':
						// case 'LogicalExpression':
						// case 'UnaryExpression':
							return augmented.augValue ?? [];
					}
				});
				node.variables.forEach((it, k) => {
					const augmented = it as aug.Identifier;
					augmented.augValue = types[k];

					this.handlers.Identifier(augmented);
				});
			},

			AssignmentStatement: (node) => {
				const types = node.init.flatMap(it => {
					this.handlers[it.type](it as any);
					const augmented = it as aug.Expression;
					switch (augmented.type) {
						case 'CallExpression':
						case 'TableCallExpression':
						case 'StringCallExpression':
							return augmented.augValues ?? [];
						case 'Identifier':
						case 'NilLiteral':
						case 'NumericLiteral':
						case 'BooleanLiteral':
						case 'StringLiteral':
						case 'VarargLiteral':
						case 'FunctionDeclaration':
						// case 'BinaryExpression':
						// case 'LogicalExpression':
						// case 'UnaryExpression':
							return augmented.augValue ?? [];
					}
				});
				node.variables.forEach((it, k) => {
					const augmented = it as aug.Identifier;
					augmented.augValue = types[k];

					// if 'name' is visible from current scope
					if (this.lookup(augmented.name)) {
						// handle locally
						// XXX: this will still shadow parent scope
						this.handlers.Identifier(augmented);
					} else {
						// switch to global scope
						const previousScope = this.currentScope;
						this.currentScope = this.globalScope;
							this.handlers.Identifier(augmented);
						this.currentScope = previousScope;
					}
				});
			},

			AssignmentOperatorStatement: (node) => {
				// every variables should exists, so this is handled like a LocalStatement
				const types = node.init.flatMap(it => {
					this.handlers[it.type](it as any);
					const augmented = it as aug.Expression;
					switch (augmented.type) {
						case 'CallExpression':
						case 'TableCallExpression':
						case 'StringCallExpression':
							return augmented.augValues ?? [];
						case 'Identifier':
						case 'NilLiteral':
						case 'NumericLiteral':
						case 'BooleanLiteral':
						case 'StringLiteral':
						case 'VarargLiteral':
						case 'FunctionDeclaration':
						// case 'BinaryExpression':
						// case 'LogicalExpression':
						// case 'UnaryExpression':
							return augmented.augValue ?? [];
					}
				});
				node.variables.forEach((it, k) => {
					const augmented = it as aug.Identifier;
					augmented.augValue = types[k];

					this.handlers.Identifier(augmented);
				});
			},

			CallStatement: (node) => {
				this.contextPush(node);
					this.handlers[node.expression.type](node.expression as any);
				this.contextPop('CallStatement');
			},

			ForNumericStatement: (node) => {
				this.contextPush(node);
					const previousScope = this.fork();
						this.handlers.Identifier(node.variable);
						[node.start, node.end, node.step].map(it => it && this.handlers[it.type](it as any));

						node.body.forEach(it => this.handlers[it.type](it as any));
					this.restore(previousScope);
				this.contextPop('WhileStatement');
			},

			ForGenericStatement: (node) => {
				this.contextPush(node);
					const previousScope = this.fork();
						node.variables.map(it => this.handlers[it.type](it as any));
						node.iterators.map(it => this.handlers[it.type](it as any)); // XXX

						node.body.forEach(it => this.handlers[it.type](it as any));
					this.restore(previousScope);
				this.contextPop('WhileStatement');
			},
		//#endregion

		//#region clauses
			IfClause: (node) => {
				this.contextPush(node);
					this.handlers[node.condition.type](node.condition as any);

					const previousScope = this.fork();
						node.body.forEach(it => this.handlers[it.type](it as any));
					this.restore(previousScope);
				this.contextPop('IfClause');
			},

			ElseifClause: (node) => {
				this.contextPush(node);
					this.handlers[node.condition.type](node.condition as any);

					const previousScope = this.fork();
						node.body.forEach(it => this.handlers[it.type](it as any));
					this.restore(previousScope);
				this.contextPop('ElseifClause');
			},

			ElseClause: (node) => {
				this.contextPush(node);
					const previousScope = this.fork();
						node.body.forEach(it => this.handlers[it.type](it as any));
					this.restore(previousScope);
				this.contextPop('ElseClause');
			},
		//#endregion

		//#region table
			TableKey: (node) => { void 1; },

			TableKeyString: (node) => { void 1; },

			TableValue: (node) => { void 1; },
		//#endregion

		//#region expressions
			TableConstructorExpression: (node) => { void 1; },

			BinaryExpression: (node) => {
				[node.left, node.right].map(it => this.handlers[it.type](it as any));
			},

			LogicalExpression: (node) => {
				[node.left, node.right].map(it => this.handlers[it.type](it as any));
			},

			UnaryExpression: (node) => {
				this.handlers[node.argument.type](node.argument as any);
			},

			MemberExpression: (node) => { void 1; }, // TODO

			IndexExpression: (node) => { void 1; }, // TODO

			CallExpression: (node) => {
				this.contextPush(node);
					const augmented = node.base as aug.Identifier;
					this.handlers.Identifier(augmented);
					(node as aug.CallExpression).augValues = [augmented.augValue!];

					node.arguments.forEach(it => this.handlers[it.type](it as any));
				this.contextPop('CallExpression');
			},

			TableCallExpression: (node) => {
				this.contextPush(node);
					const augmented = node.base as aug.Identifier;
					this.handlers.Identifier(augmented);
					(node as aug.TableCallExpression).augValues = [augmented.augValue!];

					this.handlers[node.argument.type](node.argument as any);
				this.contextPop('TableCallExpression');
			},

			StringCallExpression: (node) => {
				this.contextPush(node);
					const augmented = node.base as aug.Identifier;
					this.handlers.Identifier(augmented);
					(node as aug.StringCallExpression).augValues = [augmented.augValue!];

					this.handlers[node.argument.type](node.argument as any);
				this.contextPop('StringCallExpression');
			},
		//#endregion

		//#region literals
			StringLiteral: (node) => {
				(node as aug.StringLiteral).augValue = node;
			},

			NumericLiteral: (node) => {
				(node as aug.NumericLiteral).augValue = node;
			},

			BooleanLiteral: (node) => {
				(node as aug.BooleanLiteral).augValue = node;
			},

			NilLiteral: (node) => {
				(node as aug.NilLiteral).augValue = node;
			},

			VarargLiteral: (node) => {
				(node as aug.VarargLiteral).augValue = node;
			},
		//#endregion
		};
	}
//#endregion
}