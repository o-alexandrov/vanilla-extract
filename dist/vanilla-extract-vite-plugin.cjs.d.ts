import { Plugin } from 'vite';
import { IdentifierOption } from '@vanilla-extract/integration';

type PluginFilter = (filterProps: {
    /** The name of the plugin */
    name: string;
    /**
     * The `mode` vite is running in.
     * @see https://vite.dev/guide/env-and-mode.html#modes
     */
    mode: string;
}) => boolean;
interface Options {
    identifiers?: IdentifierOption;
    unstable_pluginFilter?: PluginFilter;
    unstable_mode?: 'transform' | 'emitCss' | 'inlineCssInDev';
    /**
     * The regex used to detect Vanilla Extract files. Override this to use a different file naming
     * convention (e.g. to match `css.ts` instead of the default `*.css.ts`).
     *
     * @default cssFileFilter
     */
    cssFileFilter?: RegExp;
}
declare function vanillaExtractPlugin({ identifiers, unstable_pluginFilter: pluginFilter, unstable_mode, cssFileFilter: fileFilter, }?: Options): Plugin[];

export { vanillaExtractPlugin };
