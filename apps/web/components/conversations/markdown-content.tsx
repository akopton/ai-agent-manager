import { Fragment, type ReactNode } from 'react';

import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from '@/lib/conversations/markdown';
import { cn } from '@/lib/utils';

const renderInline = (nodes: readonly MarkdownInline[]): ReactNode =>
  nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={index}>{node.text}</Fragment>;
      case 'code':
        return (
          <code
            key={index}
            className="rounded-md bg-inset px-1.5 py-0.5 font-mono text-[0.85em] break-words"
          >
            {node.text}
          </code>
        );
      case 'strong':
        return (
          <strong key={index} className="font-semibold">
            {renderInline(node.children)}
          </strong>
        );
      case 'em':
        return <em key={index}>{renderInline(node.children)}</em>;
      case 'link':
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-primary underline underline-offset-4 break-all"
          >
            {renderInline(node.children)}
          </a>
        );
    }
  });

const headingClasses: Record<number, string> = {
  1: 'text-lg font-semibold',
  2: 'text-base font-semibold',
  3: 'text-sm font-semibold',
  4: 'text-sm font-semibold',
  5: 'text-sm font-medium',
  6: 'text-sm font-medium text-muted-foreground',
};

const renderBlocks = (blocks: readonly MarkdownBlock[]): ReactNode =>
  blocks.map((block, index) => {
    switch (block.type) {
      case 'code':
        return (
          <figure key={index} className="overflow-hidden rounded-lg border bg-inset">
            {block.language === null ? null : (
              <figcaption className="border-b px-3 py-1 font-mono text-xs text-muted-foreground">
                {block.language}
              </figcaption>
            )}
            <pre className="overflow-x-auto px-3 py-2 text-xs leading-5">
              <code className="font-mono">{block.text}</code>
            </pre>
          </figure>
        );
      case 'heading': {
        const Tag = `h${Math.min(6, block.level + 2)}` as 'h3';
        return (
          <Tag key={index} className={headingClasses[block.level]}>
            {renderInline(block.children)}
          </Tag>
        );
      }
      case 'paragraph':
        return (
          <p key={index} className="whitespace-pre-line">
            {renderInline(block.children)}
          </p>
        );
      case 'list': {
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex} className="whitespace-pre-line">
            {renderInline(item)}
          </li>
        ));
        return block.ordered ? (
          <ol key={index} start={block.start} className="list-decimal space-y-1 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={index} className="list-disc space-y-1 pl-5">
            {items}
          </ul>
        );
      }
      case 'quote':
        return (
          <blockquote
            key={index}
            className="space-y-2 border-l-2 border-border-strong pl-3 text-muted-foreground"
          >
            {renderBlocks(block.children)}
          </blockquote>
        );
      case 'rule':
        return <hr key={index} className="border-border" />;
    }
  });

/** Renders an AI reply's Markdown safely: React elements only, no HTML injection. */
export const MarkdownContent = ({ source, className }: { source: string; className?: string }) => (
  <div className={cn('space-y-3 text-sm leading-6 break-words', className)}>
    {renderBlocks(parseMarkdown(source))}
  </div>
);
