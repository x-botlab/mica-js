/** `import './editor.css'` only asks the bundler to emit the published stylesheet. */
declare module '*.css' {
  const content: string;
  export default content;
}
