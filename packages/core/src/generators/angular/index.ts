import { SELF_CLOSING_HTML_TAGS, VALID_HTML_TAGS } from '@/constants/html_tags';
import { createSingleBinding } from '@/helpers/bindings';
import { dedent } from '@/helpers/dedent';
import { fastClone } from '@/helpers/fast-clone';
import { getChildComponents } from '@/helpers/get-child-components';
import { getComponentsUsed } from '@/helpers/get-components-used';
import { getCustomImports } from '@/helpers/get-custom-imports';
import { getPropFunctions } from '@/helpers/get-prop-functions';
import { getProps } from '@/helpers/get-props';
import { getPropsRef } from '@/helpers/get-props-ref';
import { getRefs } from '@/helpers/get-refs';
import { getStateObjectStringFromComponent } from '@/helpers/get-state-object-string';
import { getTypedFunction } from '@/helpers/get-typed-function';
import { indent } from '@/helpers/indent';
import { isMitosisNode } from '@/helpers/is-mitosis-node';
import { isUpperCase } from '@/helpers/is-upper-case';
import { mapRefs } from '@/helpers/map-refs';
import { initializeOptions } from '@/helpers/merge-options';
import { CODE_PROCESSOR_PLUGIN } from '@/helpers/plugins/process-code';
import { removeSurroundingBlock } from '@/helpers/remove-surrounding-block';
import { renderPreComponent } from '@/helpers/render-imports';
import { replaceIdentifiers, replaceNodes } from '@/helpers/replace-identifiers';
import { isSlotProperty, stripSlotPrefix, toKebabSlot } from '@/helpers/slots';
import { stripMetaProperties } from '@/helpers/strip-meta-properties';
import {
  DO_NOT_USE_VARS_TRANSFORMS,
  stripStateAndPropsRefs,
} from '@/helpers/strip-state-and-props-refs';
import { collectCss } from '@/helpers/styles/collect-css';
import { nodeHasCss } from '@/helpers/styles/helpers';
import { traverseNodes } from '@/helpers/traverse-nodes';
import {
  runPostCodePlugins,
  runPostJsonPlugins,
  runPreCodePlugins,
  runPreJsonPlugins,
} from '@/modules/plugins';
import { hashCodeAsString } from '@/symbols/symbol-processor';
import { BaseHook, MitosisComponent } from '@/types/mitosis-component';
import { Binding, MitosisNode, checkIsForNode } from '@/types/mitosis-node';
import { TranspilerGenerator } from '@/types/transpiler';
import * as babel from '@babel/core';
import { flow, pipe } from 'fp-ts/lib/function';
import { isString, kebabCase, uniq } from 'lodash';
import traverse from 'neotraverse/legacy';
import { format } from 'prettier/standalone';
import isChildren from '../../helpers/is-children';
import { stringifySingleScopeOnMount } from '../helpers/on-mount';
import {
  HELPER_FUNCTIONS,
  addCodeToOnInit,
  addCodeToOnUpdate,
  getAppropriateTemplateFunctionKeys,
  getDefaultProps,
  makeReactiveState,
  transformState,
} from './helpers';
import { standardNgEvents } from './ng_constants';
import {
  AngularBlockOptions,
  BUILT_IN_COMPONENTS,
  DEFAULT_ANGULAR_OPTIONS,
  ToAngularOptions,
} from './types';

const { types } = babel;

const mappers: {
  [key: string]: (
    root: MitosisComponent,
    json: MitosisNode,
    options: ToAngularOptions,
    blockOptions: AngularBlockOptions,
  ) => string;
} = {
  Fragment: (root, json, options, blockOptions) => {
    return `<ng-container>${json.children
      .map((item) => blockToAngular({ root, json: item, options, blockOptions }))
      .join('\n')}</ng-container>`;
  },
  Slot: (root, json, options, blockOptions) => {
    const renderChildren = () =>
      json.children
        ?.map((item) => blockToAngular({ root, json: item, options, blockOptions }))
        .join('\n');

    return `<ng-content ${Object.entries({ ...json.bindings, ...json.properties })
      .map(([binding, value]) => {
        if (value && binding === 'name') {
          const selector = pipe(isString(value) ? value : value.code, stripSlotPrefix, kebabCase);
          return `select="[${selector}]"`;
        }
      })
      .join('\n')}>${Object.entries(json.bindings)
      .map(([binding, value]) => {
        if (value && binding !== 'name') {
          return value.code;
        }
      })
      .join('\n')}${renderChildren()}</ng-content>`;
  },
};

const preprocessCssAsJson = (json: MitosisComponent) => {
  traverse(json).forEach((item) => {
    if (isMitosisNode(item)) {
      if (nodeHasCss(item)) {
        if (item.bindings.css?.code?.includes('&quot;')) {
          item.bindings.css.code = item.bindings.css.code.replace(/&quot;/g, '"');
        }
      }
    }
  });
};

const generateNgModule = (
  content: string,
  name: string,
  componentsUsed: string[],
  component: MitosisComponent,
  bootstrapMapper: Function | null | undefined,
): string => {
  return `import { NgModule } from "@angular/core";
import { CommonModule } from "@angular/common";

${content}

@NgModule({
  declarations: [${name}],
  imports: [CommonModule${
    componentsUsed.length ? ', ' + componentsUsed.map((comp) => `${comp}Module`).join(', ') : ''
  }],
  exports: [${name}],
  ${bootstrapMapper ? bootstrapMapper(name, componentsUsed, component) : ''}
})
export class ${name}Module {}`;
};

// TODO: Maybe in the future allow defining `string | function` as values
const BINDINGS_MAPPER: { [key: string]: string | undefined } = {
  innerHTML: 'innerHTML',
  style: 'ngStyle',
};

const handleObjectBindings = (code: string) => {
  let objectCode = code.replace(/^{/, '').replace(/}$/, '');
  objectCode = objectCode.replace(/\/\/.*\n/g, '');

  let temp = objectCode;

  //STEP 1. remove spread operator for expressions like '{ ...objectName }' and replace them with object name, example {...obj} => obj
  temp = temp.replace(/\{\s*\.\.\.(\w+)\s*}/g, '$1');
  //STEP 2. remove all remaining spread operators that could be nested somewhere deeper, example { ...obj, field1: value1 } => { obj, field1: value1 }
  temp = temp.replace(/\.\.\./g, '');
  //STEP 3. deal with consequences of STEP 2 - for all left field assignments we create new objects provided to useObjectWrapper,
  //and we get rid of surrounding brackets of the initial input value, example {...obj1,test:true,...obj2} => obj1, {test: true}, obj2
  temp = temp.replace(/(\s*\w+\s*:\s*((["'].+["'])|(\[.+])|([\w.]+)))(,|[\n\s]*)/g, `{ $1 },`);

  // handle template strings
  if (temp.includes('`')) {
    // template str
    let str = temp.match(/`[^`]*`/g);

    let values = str && str[0].match(/\${[^}]*}/g);
    let forValues = values?.map((val) => val.slice(2, -1)).join(' + ');

    if (str && forValues) {
      temp = temp.replace(str[0], forValues);
    }
  }

  return temp;
};

const processCodeBlockInTemplate = (code: string) => {
  // contains helper calls as Angular doesn't support JS expressions in templates
  if (code.startsWith('{') && code.includes('...')) {
    // Objects cannot be spread out directly in Angular so we need to use `useObjectWrapper`
    return `useObjectWrapper(${handleObjectBindings(code)})`;
  } else if (code.startsWith('Object.values')) {
    let stripped = code.replace('Object.values', '');
    return `useObjectDotValues${stripped}`;
  } else if (code.includes('JSON.stringify')) {
    let obj = code.match(/JSON.stringify\((.*)\)/);
    return `useJsonStringify(${obj})`;
  } else if (code.includes(' as ')) {
    const asIndex = code.indexOf('as');
    const asCode = code.slice(0, asIndex - 1);
    return `$any${asCode})`;
  } else {
    return `${code}`;
  }
};

const processEventBinding = (key: string, code: string, nodeName: string, customArg: string) => {
  let event = key.replace('on', '');
  event = event.charAt(0).toLowerCase() + event.slice(1);

  // if event is not a standard angular event after removing 'on' and lowercasing, preserve original state
  if (!standardNgEvents.has(event.toLowerCase())) {
    event = key;
  }

  // TODO: proper babel transform to replace. Util for this
  const eventName = customArg;
  const regexp = new RegExp(
    '(^|\\n|\\r| |;|\\(|\\[|!)' + eventName + '(\\?\\.|\\.|\\(| |;|\\)|$)',
    'g',
  );
  const replacer = '$1$event$2';
  const finalValue = removeSurroundingBlock(code.replace(regexp, replacer));
  return {
    event,
    value: finalValue,
  };
};

const stringifyBinding =
  (node: MitosisNode, options: ToAngularOptions, blockOptions: AngularBlockOptions) =>
  ([key, binding]: [string, Binding | undefined]) => {
    if (key.startsWith('$') || key.startsWith('"') || key === 'key') {
      return;
    }
    if (binding?.type === 'spread') {
      return;
    }

    const keyToUse = BINDINGS_MAPPER[key] || key;
    const { code, arguments: cusArgs = ['event'] } = binding!;
    // TODO: proper babel transform to replace. Util for this

    if (keyToUse.startsWith('on')) {
      const { event, value } = processEventBinding(keyToUse, code, node.name, cusArgs[0]);
      // if lowercase event is not a standard ng event, preserve original event name
      return standardNgEvents.has(event.toLowerCase())
        ? ` (${event.toLowerCase()})="${value}"`
        : ` (${event})="${value}"`;
    } else if (keyToUse === 'class') {
      return ` [class]="${code}" `;
    } else if (keyToUse === 'ref' || keyToUse === 'spreadRef') {
      return ` #${code} `;
    } else if (
      (VALID_HTML_TAGS.includes(node.name.trim()) || keyToUse.includes('-')) &&
      !blockOptions.nativeAttributes?.includes(keyToUse) &&
      !Object.values(BINDINGS_MAPPER).includes(keyToUse)
    ) {
      // standard html elements need the attr to satisfy the compiler in many cases: eg: svg elements and [fill]
      return ` [attr.${keyToUse}]="${code}" `;
    } else {
      const codeToUse =
        options.state === 'inline-with-wrappers' ? processCodeBlockInTemplate(code) : code;
      return `[${keyToUse}]="${codeToUse}"`;
    }
  };

const handleNgOutletBindings = (node: MitosisNode, options: ToAngularOptions) => {
  let allProps = '';
  for (const key in node.properties) {
    if (key.startsWith('$')) {
      continue;
    }
    if (key === 'key') {
      continue;
    }
    const value = node.properties[key];
    allProps += `${key}: '${value}', `;
  }

  for (const key in node.bindings) {
    if (key.startsWith('"')) {
      continue;
    }
    if (key.startsWith('$')) {
      continue;
    }
    let { code, arguments: cusArgs = ['event'] } = node.bindings[key]!;
    if (options.state === 'class-properties') {
      code = `this.${code}`;

      if (node.bindings[key]?.type === 'spread') {
        allProps += `...${code}, `;
        continue;
      }
    }

    let keyToUse = key.includes('-') ? `'${key}'` : key;
    keyToUse = keyToUse.replace('state.', '').replace('props.', '');

    if (key.startsWith('on')) {
      const { event, value } = processEventBinding(key, code, node.name, cusArgs[0]);
      allProps += `on${event.charAt(0).toUpperCase() + event.slice(1)}: ${value.replace(
        /\(.*?\)/g,
        '',
      )}.bind(this), `;
    } else {
      const codeToUse =
        options.state === 'inline-with-wrappers' ? processCodeBlockInTemplate(code) : code;
      allProps += `${keyToUse}: ${codeToUse}, `;
    }
  }

  if (allProps.endsWith(', ')) {
    allProps = allProps.slice(0, -2);
  }

  if (allProps.startsWith(', ')) {
    allProps = allProps.slice(2);
  }

  return allProps;
};

export const blockToAngular = ({
  root,
  json,
  options = {},
  blockOptions = {
    nativeAttributes: [],
  },
}: {
  root: MitosisComponent;
  json: MitosisNode;
  options?: ToAngularOptions;
  blockOptions?: AngularBlockOptions;
}): string => {
  const childComponents = blockOptions?.childComponents || [];

  if (mappers[json.name]) {
    return mappers[json.name](root, json, options, blockOptions);
  }

  if (isChildren({ node: json })) {
    return `<ng-content></ng-content>`;
  }

  if (json.properties._text) {
    return json.properties._text;
  }
  const textCode = json.bindings._text?.code;
  if (textCode) {
    if (isSlotProperty(textCode)) {
      return `<ng-content select="[${toKebabSlot(textCode)}]"></ng-content>`;
    }

    if (textCode.includes('JSON.stringify')) {
      const obj = textCode.replace(/JSON.stringify\(\s*(\w+)\s*,?.*\)/, '$1');
      return `{{${obj} | json}}`;
    }

    return `{{${textCode}}}`;
  }

  let str = '';

  if (checkIsForNode(json)) {
    const indexName = json.scope.indexName;
    const forName = json.scope.forName;

    // Check if "key" is present for the first child of the for loop
    if (json.children[0].bindings && json.children[0].bindings.key?.code) {
      const fnIndex = (root.meta?._trackByForIndex as number) || 0;
      const trackByFnName = `trackBy${
        forName ? forName.charAt(0).toUpperCase() + forName.slice(1) : ''
      }${fnIndex}`;
      root.meta._trackByForIndex = fnIndex + 1;
      let code = json.children[0].bindings.key?.code;

      root.state[trackByFnName] = {
        code: `${trackByFnName}(${indexName ?? '_'}, ${forName}) { return ${code}; }`,
        type: 'method',
      };

      str += `<ng-container *ngFor="let ${forName ?? '_'} of ${json.bindings.each?.code}${
        indexName ? `; index as ${indexName}` : ''
      }; trackBy: ${trackByFnName}">`;
    } else {
      str += `<ng-container *ngFor="let ${forName ?? '_'} of ${json.bindings.each?.code}${
        indexName ? `; index as ${indexName}` : ''
      }">`;
    }
    str += json.children
      .map((item) => blockToAngular({ root, json: item, options, blockOptions }))
      .join('\n');
    str += `</ng-container>`;
  } else if (json.name === 'Show') {
    let condition = json.bindings.when?.code;
    if (options.state === 'inline-with-wrappers' && condition?.includes('typeof')) {
      let wordAfterTypeof = condition.split('typeof')[1].trim().split(' ')[0];
      condition = condition.replace(`typeof ${wordAfterTypeof}`, `useTypeOf(${wordAfterTypeof})`);
    }
    str += `<ng-container *ngIf="${condition}">`;
    str += json.children
      .map((item) => blockToAngular({ root, json: item, options, blockOptions }))
      .join('\n');
    str += `</ng-container>`;
    // else condition
    if (isMitosisNode(json.meta?.else)) {
      str += `<ng-container *ngIf="!(${condition})">`;
      str += blockToAngular({ root, json: json.meta.else, options, blockOptions });
      str += `</ng-container>`;
    }
  } else if (json.name.includes('.')) {
    const elSelector = childComponents.find((impName) => impName === json.name)
      ? kebabCase(json.name)
      : json.name;

    let allProps = handleNgOutletBindings(json, options);
    if (options.state === 'class-properties') {
      const inputsPropsStateName = `mergedInputs_${hashCodeAsString(allProps)}`;
      root.state[inputsPropsStateName] = {
        code: '{}' + (options.typescript ? ' as any' : ''),
        type: 'property',
      };
      if (!root.hooks.onInit?.code.includes(inputsPropsStateName)) {
        addCodeToOnInit(root, `this.${inputsPropsStateName} = {${allProps}};`);
      }
      if (
        !root.hooks.onUpdate
          ?.map((hook) => hook.code)
          .join('')
          .includes(inputsPropsStateName)
      ) {
        addCodeToOnUpdate(root, `this.${inputsPropsStateName} = {${allProps}};`);
      }
      allProps = `${inputsPropsStateName}`;
    } else {
      allProps = `{ ${allProps} }`;
    }

    str += `<ng-container *ngComponentOutlet="
      ${elSelector.replace('state.', '').replace('props.', '')};
      inputs: ${allProps};
      content: myContent;
      ">  `;

    str += `</ng-container>`;
  } else {
    const elSelector = childComponents.find((impName) => impName === json.name)
      ? kebabCase(json.name)
      : json.name;
    str += `<${elSelector} `;

    for (const key in json.properties) {
      if (key.startsWith('$')) {
        continue;
      }
      const value = json.properties[key];
      str += ` ${key}="${value}" `;
    }

    for (const key in json.bindings) {
      if (json.bindings[key]?.type === 'spread' && VALID_HTML_TAGS.includes(json.name.trim())) {
        if (json.bindings[key]?.code === 'this') {
          // if its an arbitrary { ...props } spread then we skip because Angular needs a named prop to be defined
          continue;
        }

        let refName = '';
        if (json.bindings['spreadRef']?.code) {
          refName = json.bindings['spreadRef'].code;
        } else {
          const spreadRefIndex = root.meta._spreadRefIndex || 0;
          refName = `elRef${spreadRefIndex}`;
          root.meta._spreadRefIndex = (spreadRefIndex as number) + 1;
          json.bindings['spreadRef'] = createSingleBinding({ code: refName });
          root.refs[refName] = { argument: '' };
        }
        json.bindings['spreadRef'] = createSingleBinding({ code: refName });
        root.refs[refName] = { argument: '' };
        root.meta.onViewInit = (root.meta.onViewInit || { code: '' }) as BaseHook;
        let spreadCode = '';
        let changesCode = '';
        if (json.bindings[key]?.code.startsWith('{')) {
          json.meta._spreadStateRef = json.meta._spreadStateRef || 0;
          const name = `${refName}_state_${json.meta._spreadStateRef}`;
          json.meta._spreadStateRef = (json.meta._spreadStateRef as number) + 1;
          makeReactiveState(root, name, `this.${name} = ${json.bindings[key]?.code};`);
          spreadCode = `this.${name}`;
          changesCode = `changes['${spreadCode.replace('this.', '')}']?.currentValue`;
        } else {
          spreadCode = `${json.bindings[key]?.code}`;
          changesCode = `changes['${spreadCode.replace('this.', '')}']?.currentValue`;
        }
        if (!root.compileContext) {
          root.compileContext = {
            angular: {
              hooks: {
                ngAfterViewInit: {
                  code: '',
                },
              },
            },
          };
        }
        root.compileContext.angular!.hooks!.ngAfterViewInit.code += `\nthis.setAttributes(this.${refName}?.nativeElement, ${spreadCode});`;
        addCodeToOnUpdate(
          root,
          `this.setAttributes(this.${refName}?.nativeElement, ${spreadCode}${
            changesCode ? `, ${changesCode}` : ''
          });`,
        );
        if (!root.state['setAttributes']) {
          root.state['setAttributes'] = {
            code: HELPER_FUNCTIONS(options?.typescript).setAttributes as string,
            type: 'method',
          };
        }
      }
    }

    const stringifiedBindings = Object.entries(json.bindings)
      .map(stringifyBinding(json, options, blockOptions))
      .join('');

    str += stringifiedBindings;
    if (SELF_CLOSING_HTML_TAGS.has(json.name)) {
      return str + ' />';
    }
    str += '>';

    if (json.children) {
      str += json.children
        .map((item) => blockToAngular({ root, json: item, options, blockOptions }))
        .join('\n');
    }

    str += `</${elSelector}>`;
  }
  return str;
};

const traverseToGetAllDynamicComponents = (
  json: MitosisComponent,
  options: ToAngularOptions,
  blockOptions: AngularBlockOptions,
) => {
  const components: Set<string> = new Set();
  let dynamicTemplate = '';
  traverse(json).forEach((item) => {
    if (isMitosisNode(item) && item.name.includes('.') && item.name.split('.').length === 2) {
      const children = item.children
        .map((child) => blockToAngular({ root: json, json: child, options, blockOptions }))
        .join('\n');
      dynamicTemplate = `<ng-template #${
        item.name.split('.')[1].toLowerCase() + 'Template'
      }>${children}</ng-template>`;
      components.add(item.name);
    }
  });
  return {
    components,
    dynamicTemplate,
  };
};

/**
 * Prefixes state identifiers with this.
 * e.g. state.foo --> this.foo
 */
const prefixState = (code: string): string => {
  return replaceNodes({
    code,
    nodeMaps: [
      {
        from: types.identifier('state'),
        to: types.thisExpression(),
      },
    ],
  }).trim();
};

const processAngularCode =
  ({
    contextVars,
    outputVars,
    domRefs,
    replaceWith,
  }: {
    contextVars: string[];
    outputVars: string[];
    domRefs: string[];
    replaceWith?: string;
  }) =>
  (code: string) =>
    pipe(
      DO_NOT_USE_VARS_TRANSFORMS(code, {
        contextVars,
        domRefs,
        outputVars,
      }),
      /**
       * Only prefix state that is in the Angular class component.
       * Do not prefix state referenced in the template
       */
      replaceWith === 'this' ? prefixState : (x) => x,
      (newCode) => stripStateAndPropsRefs(newCode, { replaceWith }),
    );

const isASimpleProperty = (code: string) => {
  const expressions = ['==', '===', '!=', '!==', '<', '>', '<=', '>='];
  const invalidChars = ['{', '}', '(', ')', 'typeof'];

  return !invalidChars.some((char) => code.includes(char)) && !expressions.includes(code);
};

const generateNewBindingName = (index: number, name: string) =>
  `node_${index}_${name.replaceAll('.', '_').replaceAll('-', '_')}`;

const handleBindings = (
  json: MitosisComponent,
  item: MitosisNode,
  index: number,
  forName?: string,
  indexName?: string,
) => {
  for (const key in item.bindings) {
    if (
      key.startsWith('"') ||
      key.startsWith('$') ||
      key === 'css' ||
      key === 'ref' ||
      isASimpleProperty(item.bindings[key]!.code)
    ) {
      continue;
    }

    const newBindingName = generateNewBindingName(index, item.name);

    if (forName) {
      if (item.name === 'For') continue;
      if (key === 'key') continue;

      if (key.startsWith('on')) {
        const { arguments: cusArgs = ['event'] } = item.bindings[key]!;
        const eventBindingName = `${generateNewBindingName(index, item.name)}_event`;
        if (
          item.bindings[key]?.code.trim().startsWith('{') &&
          item.bindings[key]?.code.trim().endsWith('}')
        ) {
          const forAndIndex = `${forName ? `, ${forName}` : ''}${
            indexName ? `, ${indexName}` : ''
          }`;
          const eventArgs = `${cusArgs.join(', ')}${forAndIndex}`;
          json.state[eventBindingName] = {
            code: `(${eventArgs}) => ${item.bindings[key]!.code}`,
            type: 'function',
          };
          item.bindings[key]!.code = `state.${eventBindingName}(${eventArgs})`;
          json.state[newBindingName] = {
            code: `(${eventArgs}) => (${item.bindings[key]!.code})`,
            type: 'function',
          };
          item.bindings[key]!.code = `state.${newBindingName}($${eventArgs})`;
        }
      } else {
        json.state[newBindingName] = {
          code: `(${forName}${indexName ? `, ${indexName}` : ''}) => (${item.bindings[key]!.code})`,
          type: 'function',
        };
        item.bindings[key]!.code = `state.${newBindingName}(${forName}${
          indexName ? `, ${indexName}` : ''
        })`;
      }
    } else if (item.bindings[key]?.code) {
      if (item.bindings[key]?.type !== 'spread' && !key.startsWith('on')) {
        json.state[newBindingName] = { code: 'null', type: 'property' };
        makeReactiveState(
          json,
          newBindingName,
          `this.${newBindingName} = ${item.bindings[key]!.code}`,
        );
        item.bindings[key]!.code = `state.${newBindingName}`;
      } else if (key.startsWith('on')) {
        const { arguments: cusArgs = ['event'] } = item.bindings[key]!;
        if (
          item.bindings[key]?.code.trim().startsWith('{') &&
          item.bindings[key]?.code.trim().endsWith('}')
        ) {
          json.state[newBindingName] = {
            code: `(${cusArgs.join(', ')}) => ${item.bindings[key]!.code}`,
            type: 'function',
          };
          item.bindings[key]!.code = `state.${newBindingName}(${cusArgs.join(', ')})`;
        }
      } else {
        makeReactiveState(
          json,
          newBindingName,
          `state.${newBindingName} = {...(${item.bindings[key]!.code})}`,
        );
        item.bindings[newBindingName] = item.bindings[key];
        item.bindings[key]!.code = `state.${newBindingName}`;
        delete item.bindings[key];
      }
    }
    index++;
  }
  return index;
};

const handleProperties = (json: MitosisComponent, item: MitosisNode, index: number) => {
  for (const key in item.properties) {
    if (key.startsWith('$') || isASimpleProperty(item.properties[key]!)) {
      continue;
    }
    const newBindingName = generateNewBindingName(index, item.name);
    json.state[newBindingName] = { code: '`' + `${item.properties[key]}` + '`', type: 'property' };
    item.bindings[key] = createSingleBinding({ code: `state.${newBindingName}` });
    delete item.properties[key];
    index++;
  }
  return index;
};

const handleAngularBindings = (
  json: MitosisComponent,
  item: MitosisNode,
  index: number,
  { forName, indexName }: { forName?: string; indexName?: string } = {},
): number => {
  if (isChildren({ node: item })) return index;

  index = handleBindings(json, item, index, forName, indexName);
  index = handleProperties(json, item, index);

  return index;
};

const classPropertiesPlugin = () => ({
  json: {
    pre: (json: MitosisComponent) => {
      let lastId = 0;
      traverseNodes(json, (item) => {
        if (isMitosisNode(item)) {
          if (item.name === 'For') {
            const forName = (item.scope as any).forName;
            const indexName = (item.scope as any).indexName;
            traverseNodes(item, (child) => {
              if (isMitosisNode(child)) {
                (child as any)._traversed = true;
                lastId = handleAngularBindings(json, child, lastId, {
                  forName,
                  indexName,
                });
              }
            });
          } else if (!(item as any)._traversed) {
            lastId = handleAngularBindings(json, item, lastId);
          }
        }
      });
      return json;
    },
  },
});

export const componentToAngular: TranspilerGenerator<ToAngularOptions> =
  (userOptions = {}) =>
  ({ component: _component }) => {
    // Make a copy we can safely mutate, similar to babel's toolchain
    let json = fastClone(_component);

    const useMetadata = json.meta?.useMetadata;

    const contextVars = Object.keys(json?.context?.get || {});
    // TODO: Why is 'outputs' used here and shouldn't it be typed in packages/core/src/types/metadata.ts
    const metaOutputVars: string[] = (useMetadata?.outputs as string[]) || [];

    const outputVars = uniq([...metaOutputVars, ...getPropFunctions(json)]);

    const options = initializeOptions({
      target: 'angular',
      component: _component,
      defaults: DEFAULT_ANGULAR_OPTIONS,
      userOptions: userOptions,
    });
    options.plugins = [
      ...(options.plugins || []),
      CODE_PROCESSOR_PLUGIN((codeType, _, node) => {
        switch (codeType) {
          case 'hooks':
            return flow(
              processAngularCode({
                replaceWith: 'this',
                contextVars,
                outputVars,
                domRefs: Array.from(getRefs(json)),
              }),
              (code) => {
                const allMethodNames = Object.entries(json.state)
                  .filter(([_, value]) => value?.type === 'function' || value?.type === 'method')
                  .map(([key]) => key);

                return replaceIdentifiers({
                  code,
                  from: allMethodNames,
                  to: (name) => `this.${name}`,
                });
              },
            );

          case 'bindings':
            return (code, key) => {
              // we create a separate state property for spread binding and use ref to attach the attributes
              // so we need to use `this.` inside the class to access state and props
              const isSpreadAttributeBinding =
                node?.bindings[key]?.type === 'spread' &&
                VALID_HTML_TAGS.includes(node.name.trim());

              const newLocal = processAngularCode({
                contextVars: [],
                outputVars,
                domRefs: [], // the template doesn't need the this keyword.
                replaceWith: isSpreadAttributeBinding ? 'this' : undefined,
              })(code);
              return newLocal.replace(/"/g, '&quot;');
            };
          case 'hooks-deps':
          case 'state':
          case 'context-set':
          case 'properties':
          case 'dynamic-jsx-elements':
          case 'types':
            return (x) => x;
        }
      }),
    ];

    if (options.state === 'class-properties') {
      options.plugins.push(classPropertiesPlugin);
    }

    if (options.plugins) {
      json = runPreJsonPlugins({ json, plugins: options.plugins });
    }

    const [forwardProp, hasPropRef] = getPropsRef(json, true);
    const propsTypeRef = json.propsTypeRef !== 'any' ? json.propsTypeRef : undefined;

    const childComponents: string[] = getChildComponents(json);

    const customImports = getCustomImports(json);

    const { exports: localExports = {} } = json;
    const localExportVars = Object.keys(localExports)
      .filter((key) => localExports[key].usedInLocal)
      .map((key) => `${key} = ${key};`);

    const injectables: string[] = contextVars.map((variableName) => {
      const variableType = json?.context?.get[variableName].name;
      if (options?.experimental?.injectables) {
        return options?.experimental?.injectables(variableName, variableType);
      }
      if (options?.experimental?.inject) {
        return `@Inject(forwardRef(() => ${variableType})) public ${variableName}: ${variableType}`;
      }
      return `public ${variableName} : ${variableType}`;
    });

    const props = getProps(json);
    // prevent jsx props from showing up as @Input
    if (hasPropRef) {
      props.delete(forwardProp);
    }
    props.delete('children');

    // remove props for outputs
    outputVars.forEach((variableName) => {
      props.delete(variableName);
    });

    const outputs = outputVars.map((variableName) => {
      if (options?.experimental?.outputs) {
        return options?.experimental?.outputs(json, variableName);
      }
      return `@Output() ${variableName} = new EventEmitter()`;
    });

    const domRefs = getRefs(json);
    const jsRefs = Object.keys(json.refs).filter((ref) => !domRefs.has(ref));
    const componentsUsed = Array.from(getComponentsUsed(json)).filter((item) => {
      return item.length && isUpperCase(item[0]) && !BUILT_IN_COMPONENTS.has(item);
    });

    mapRefs(json, (refName) => {
      const isDomRef = domRefs.has(refName);
      return `this.${isDomRef ? '' : '_'}${refName}${isDomRef ? '.nativeElement' : ''}`;
    });

    if (options.plugins) {
      json = runPostJsonPlugins({ json, plugins: options.plugins });
    }

    preprocessCssAsJson(json);
    let css = collectCss(json);
    if (options.prettier !== false) {
      css = tryFormat(css, 'css');
    }

    const helperFunctions = new Set<string>();

    let template = json.children
      .map((item) => {
        const tmpl = blockToAngular({
          root: json,
          json: item,
          options,
          blockOptions: {
            childComponents,
            nativeAttributes: useMetadata?.angular?.nativeAttributes ?? [],
          },
        });
        if (options.state === 'inline-with-wrappers') {
          getAppropriateTemplateFunctionKeys(tmpl).forEach((key) =>
            helperFunctions.add(HELPER_FUNCTIONS(options.typescript)[key]),
          );
        }
        return tmpl;
      })
      .join('\n');

    if (options.prettier !== false) {
      template = tryFormat(template, 'html');
    }

    stripMetaProperties(json);

    const { components: dynamicComponents, dynamicTemplate } = traverseToGetAllDynamicComponents(
      json,
      options,
      {
        childComponents,
        nativeAttributes: useMetadata?.angular?.nativeAttributes ?? [],
      },
    );

    transformState(json);

    const dataString = getStateObjectStringFromComponent(json, {
      format: 'class',
      withType: options.typescript,
      valueMapper: (code, type, typeParameter) => {
        let value = code;
        if (type !== 'data') {
          value = getTypedFunction(code, options.typescript, typeParameter);
        }

        return processAngularCode({
          replaceWith: 'this',
          contextVars,
          outputVars,
          domRefs: Array.from(domRefs),
        })(value);
      },
    });

    const refsForObjSpread = getRefs(json, 'spreadRef');

    const hostDisplayCss = options.visuallyIgnoreHostElement ? ':host { display: contents; }' : '';
    const styles = css.length ? [hostDisplayCss, css].join('\n') : hostDisplayCss;

    // Preparing built in component metadata parameters
    const componentMetadata: Record<string, any> = {
      selector: useMetadata?.angular?.selector
        ? `'${useMetadata?.angular?.selector}'`
        : `'${kebabCase(json.name || 'my-component')}'`,
      template: `\`
      ${indent(dynamicTemplate, 8).replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}
      ${indent(template, 8).replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}
      \``,
      ...(styles
        ? {
            styles: `[\`${indent(styles, 8)}\`]`,
          }
        : {}),
      ...(options.standalone
        ? // TODO: also add child component imports here as well
          {
            standalone: 'true',
            imports: `[${['CommonModule', ...componentsUsed].join(', ')}]`,
          }
        : {}),
    };
    // Taking into consideration what user has passed in options and allowing them to override the default generated metadata
    Object.entries(json.meta.angularConfig || {}).forEach(([key, value]) => {
      componentMetadata[key] = value;
    });

    const hasConstructor =
      Boolean(injectables.length) || dynamicComponents.size || refsForObjSpread.size;

    const angularCoreImports = [
      ...(outputs.length ? ['Output', 'EventEmitter'] : []),
      ...(options?.experimental?.inject ? ['Inject', 'forwardRef'] : []),
      'Component',
      ...(domRefs.size || dynamicComponents.size || refsForObjSpread.size
        ? ['ViewChild', 'ElementRef']
        : []),
      ...(refsForObjSpread.size ? ['Renderer2'] : []),
      ...(props.size ? ['Input'] : []),
      ...(dynamicComponents.size ? ['ViewContainerRef', 'TemplateRef'] : []),
      ...(json.hooks.onUpdate?.length && options.typescript ? ['SimpleChanges'] : []),
    ].join(', ');

    let str = dedent`
    import { ${angularCoreImports} } from '@angular/core';
    ${options.standalone ? `import { CommonModule } from '@angular/common';` : ''}

    ${json.types ? json.types.join('\n') : ''}
    ${getDefaultProps(json)}
    ${renderPreComponent({
      explicitImportFileExtension: options.explicitImportFileExtension,
      component: json,
      target: 'angular',
      excludeMitosisComponents: !options.standalone && !options.preserveImports,
      preserveFileExtensions: options.preserveFileExtensions,
      componentsUsed,
      importMapper: options?.importMapper,
    })}

    @Component({
      ${Object.entries(componentMetadata)
        .map(([k, v]) => `${k}: ${v}`)
        .join(',')}
    })
    export default class ${json.name} {
      ${localExportVars.join('\n')}
      ${customImports.map((name) => `${name} = ${name}`).join('\n')}

      ${Array.from(props)
        .filter((item) => !isSlotProperty(item) && item !== 'children')
        .map((item) => {
          const propType = propsTypeRef ? `${propsTypeRef}["${item}"]` : 'any';
          let propDeclaration = `@Input() ${item}${options.typescript ? `!: ${propType}` : ''}`;
          if (json.defaultProps && json.defaultProps.hasOwnProperty(item)) {
            propDeclaration += ` = defaultProps["${item}"]`;
          }
          return propDeclaration;
        })
        .join('\n')}

      ${outputs.join('\n')}

      ${Array.from(domRefs)
        .map(
          (refName) =>
            `@ViewChild('${refName}') ${refName}${options.typescript ? '!: ElementRef' : ''}`,
        )
        .join('\n')}

      ${Array.from(refsForObjSpread)
        .map(
          (refName) =>
            `@ViewChild('${refName}') ${refName}${options.typescript ? '!: ElementRef' : ''}`,
        )
        .join('\n')}

      ${Array.from(dynamicComponents)
        .map(
          (component) =>
            `@ViewChild('${component
              .split('.')[1]
              .toLowerCase()}Template', { static: true }) ${component
              .split('.')[1]
              .toLowerCase()}TemplateRef${options.typescript ? '!: TemplateRef<any>' : ''}`,
        )
        .join('\n')}

      ${dynamicComponents.size ? `myContent${options.typescript ? '?: any[][];' : ''}` : ''}
      ${
        refsForObjSpread.size
          ? `_listenerFns = new Map${options.typescript ? '<string, () => void>' : ''}()`
          : ''
      }

      ${dataString}

      ${helperFunctions.size ? Array.from(helperFunctions).join('\n') : ''}

      ${jsRefs
        .map((ref) => {
          const argument = json.refs[ref].argument;
          const typeParameter = json.refs[ref].typeParameter;
          return `private _${ref}${typeParameter ? `: ${typeParameter}` : ''}${
            argument
              ? ` = ${processAngularCode({
                  replaceWith: 'this.',
                  contextVars,
                  outputVars,
                  domRefs: Array.from(domRefs),
                })(argument)}`
              : ''
          };`;
        })
        .join('\n')}

      ${
        !hasConstructor
          ? ''
          : `constructor(\n${injectables.join(',\n')}${
              dynamicComponents.size
                ? `\nprivate vcRef${options.typescript ? ': ViewContainerRef' : ''},\n`
                : ''
            }${
              refsForObjSpread.size
                ? `\nprivate renderer${options.typescript ? ': Renderer2' : ''},\n`
                : ''
            }) {}
          `
      }
      ${
        !json.hooks.onMount.length && !dynamicComponents.size && !json.hooks.onInit?.code
          ? ''
          : `ngOnInit() {
              ${
                !json.hooks?.onInit
                  ? ''
                  : `
                    ${json.hooks.onInit?.code}
                    `
              }
              ${
                json.hooks.onMount.length > 0
                  ? `
                    if (typeof window !== 'undefined') {
                      ${stringifySingleScopeOnMount(json)}
                    }
                    `
                  : ''
              }
              ${
                dynamicComponents.size
                  ? `
              this.myContent = [${Array.from(dynamicComponents)
                .map(
                  (component) =>
                    `this.vcRef.createEmbeddedView(this.${component
                      .split('.')[1]
                      .toLowerCase()}TemplateRef).rootNodes`,
                )
                .join(', ')}];
              `
                  : ''
              }
            }`
      }

      ${
        // hooks specific to Angular
        json.compileContext?.angular?.hooks
          ? Object.entries(json.compileContext?.angular?.hooks).map(([key, value]) => {
              return `${key}() {
            ${value.code}
          }`;
            })
          : ''
      }

      ${
        !json.hooks.onUpdate?.length
          ? ''
          : `ngOnChanges(changes${options.typescript ? ': SimpleChanges' : ''}) {
              if (typeof window !== 'undefined') {
                ${json.hooks.onUpdate?.reduce((code, hook) => {
                  code += hook.code;
                  return code + '\n';
                }, '')}
              }
            }
                `
      }

      ${
        !json.hooks.onUnMount && !refsForObjSpread.size
          ? ''
          : `ngOnDestroy() {
              ${json.hooks.onUnMount?.code || ''}
              ${
                refsForObjSpread.size
                  ? `for (const fn of this._listenerFns.values()) { fn(); }`
                  : ''
              }
            }`
      }

    }
  `;

    if (options.standalone !== true) {
      str = generateNgModule(str, json.name, componentsUsed, json, options.bootstrapMapper);
    }
    if (options.plugins) {
      str = runPreCodePlugins({ json, code: str, plugins: options.plugins });
    }
    if (options.prettier !== false) {
      str = tryFormat(str, 'typescript');
    }
    if (options.plugins) {
      str = runPostCodePlugins({ json, code: str, plugins: options.plugins });
    }

    return str;
  };

const tryFormat = (str: string, parser: string) => {
  try {
    return format(str, {
      parser,
      plugins: [
        // To support running in browsers
        require('prettier/parser-typescript'),
        require('prettier/parser-postcss'),
        require('prettier/parser-html'),
        require('prettier/parser-babel'),
      ],
      htmlWhitespaceSensitivity: 'ignore',
    });
  } catch (err) {
    console.warn('Could not prettify', { string: str }, err);
  }
  return str;
};
