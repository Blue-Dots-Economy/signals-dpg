import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed space-y-3 [&>h1]:text-xl [&>h1]:font-semibold [&>h2]:text-lg [&>h2]:font-semibold [&>h3]:text-base [&>h3]:font-semibold [&>ul]:list-disc [&>ul]:pl-5 [&>ol]:list-decimal [&>ol]:pl-5 [&>a]:underline [&>a]:text-primary [&>blockquote]:border-l-4 [&>blockquote]:pl-4 [&>blockquote]:italic [&>pre]:bg-muted [&>pre]:rounded [&>pre]:p-3 [&>code]:bg-muted [&>code]:rounded [&>code]:px-1 [&>hr]:border-border">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
