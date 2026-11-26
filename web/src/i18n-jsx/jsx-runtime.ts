import * as R from 'react/jsx-runtime'
import { fixProps } from '../i18n'

export type { JSX } from 'react/jsx-runtime'
export const Fragment = R.Fragment
export const jsx = (type: any, props: any, key?: any) => R.jsx(type, fixProps(type, props), key)
export const jsxs = (type: any, props: any, key?: any) => R.jsxs(type, fixProps(type, props), key)
