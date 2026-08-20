import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Descendant selectors (`[&_x]`), NOT child (`[&>x]`): markdown nests links
// inside paragraphs/list-items/table-cells and cells inside table/thead/tbody,
// so child-only selectors left them unstyled (uncoloured links, borderless
// tables). Link colour is the network theme's `--primary` (blue on blue_dot),
// so it's themeable per network rather than a hardcoded blue.
const PROSE = [
  'text-sm leading-relaxed space-y-3',
  '[&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:text-base [&_h3]:font-semibold',
  '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_a]:text-primary [&_a]:underline hover:[&_a]:opacity-80',
  '[&_img]:max-w-full [&_img]:rounded [&_img]:my-2',
  // Tables (remark-gfm): full-width, collapsed borders on every cell + header shade.
  '[&_table]:w-full [&_table]:border-collapse [&_table]:my-3 [&_table]:text-xs',
  '[&_th]:border [&_th]:border-border [&_th]:p-2 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-muted',
  '[&_td]:border [&_td]:border-border [&_td]:p-2 [&_td]:align-top',
  '[&_blockquote]:border-l-4 [&_blockquote]:pl-4 [&_blockquote]:italic',
  '[&_pre]:bg-muted [&_pre]:rounded [&_pre]:p-3 [&_code]:bg-muted [&_code]:rounded [&_code]:px-1',
  '[&_hr]:border-border',
].join(' ');

export function Markdown({ children }: { children: string }) {
  return (
    <div className={PROSE}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // External links open in a new tab, safely.
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
