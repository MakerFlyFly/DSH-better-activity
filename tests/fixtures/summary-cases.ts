/** Public-text examples shared by the upgrade test and isolated preview. */
export const summaryCases = [
  { id: 'mixed-inline', title: '摘要验证：混合 Markdown', text: '**完成 `user_id`**', preview: '完成 user_id' },
  { id: 'triple-inline', title: '摘要验证：三反引号行内代码', text: '```my_file.ts```', preview: 'my_file.ts' },
  { id: 'longer-fence', title: '摘要验证：较长结束围栏', text: '```ts\nconst user_id = 1\n````\n**Done**', preview: 'const user_id = 1 Done' },
] as const
