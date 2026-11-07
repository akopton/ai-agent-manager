import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { FolderGit2, Settings2 } from 'lucide-react';
import { conversationContextModeLabels } from '@ai-agent-manager/core';

import { ConversationChat } from '@/components/conversations/conversation-chat';
import { ConversationViews } from '@/components/conversations/conversation-views';
import { ConversationNotes } from '@/components/conversations/conversation-notes';
import { ConversationAutoRefresh } from '@/components/conversations/conversation-auto-refresh';
import { ConversationHistory } from '@/components/conversations/conversation-history';
import { ConversationAiNotice } from '@/components/conversations/conversation-notice';
import { ConversationSettingsForm } from '@/components/conversations/conversation-settings-form';
import { MessageComposer } from '@/components/conversations/message-composer';
import { TaskProposalsPanel } from '@/components/conversations/task-proposals-panel';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { describeLanguageMode } from '@/lib/conversations/format';
import { hasActiveGeneration } from '@/lib/conversations/proposals';
import { hasActiveTurn } from '@/lib/conversations/transcript';
import { describeModelChoice } from '@/lib/models/model-selection';
import { findConversationDetail } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { getProjectDetails } from '@/lib/server/projects';
import { agentRuntimeLabels } from '@/lib/tasks/board';

export const metadata: Metadata = { title: 'Conversation · AI Agent Manager' };

const ConversationPage = async ({
  params,
}: {
  params: Promise<{ projectId: string; conversationId: string }>;
}) => {
  await connection();
  const { projectId, conversationId } = await params;
  const result = await loadForPage(() =>
    findConversationDetail(getDatabase(), projectId, conversationId),
  );

  if (!result.ok) {
    return <DatabaseNotReady message={result.message} />;
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project, conversation, messages, turns, ai, generations, proposals, sourceAccess } =
    result.data;
  const projectAware = conversation.contextMode === 'project_aware';
  const active = hasActiveTurn(turns);
  const generating = hasActiveGeneration(generations);
  const model = describeModelChoice(conversation.agentRuntime, conversation.modelId);
  // Branches for the proposal editor are read live (read-only), and only while drafts exist.
  const branches = proposals.some((proposal) => proposal.status === 'draft')
    ? await getProjectDetails(getDatabase(), project.id)
        .then((details) =>
          details?.repository.status === 'available' ? details.repository.branches : null,
        )
        .catch(() => null)
    : null;
  const contextNotice = (
    <div className="space-y-3">
      <ConversationAiNotice ai={ai} />
      {projectAware ? (
        <Alert variant={sourceAccess.current ? 'info' : 'warning'}>
          <FolderGit2 aria-hidden="true" />
          <AlertTitle>
            {sourceAccess.current
              ? 'Project-Aware: repository content is shared'
              : 'Project-Aware: source sharing is not allowed yet'}
          </AlertTitle>
          <AlertDescription>
            <p>
              {sourceAccess.current
                ? `With each message, the CLI first chooses files from a list of ${project.name}'s eligible tracked and untracked source files (current working tree of the registered checkout); AI Agent Manager then reads bounded excerpts read-only and sends them to the provider with your message. Sensitive, ignored, dependency and build files are excluded. Current saved edits are included; ignored files are excluded.`
                : 'Allow source sharing for this project in Project Settings, or switch the conversation to General Chat. Until then, messages are refused and nothing is read.'}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
  return (
    <>
      <ConversationAutoRefresh active={active || generating} />
      <section aria-labelledby="page-title" className="space-y-3">
        <h1 id="page-title" className="text-2xl font-semibold tracking-tight break-words">
          {conversation.title}
        </h1>
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Runtime</dt>
            <dd className="font-medium">{agentRuntimeLabels[conversation.agentRuntime]}</dd>
          </div>
          <div className="flex min-w-0 gap-2">
            <dt className="text-muted-foreground">Model</dt>
            <dd className="font-medium break-all">{model}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Language</dt>
            <dd className="font-medium">{describeLanguageMode(conversation.languageMode)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Context</dt>
            <dd className="font-medium">
              {conversationContextModeLabels[conversation.contextMode]}
            </dd>
          </div>
        </dl>
        <details className="group rounded-xl border bg-card p-4">
          <summary className="flex w-fit items-center gap-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Settings2 className="size-4" aria-hidden="true" /> Conversation settings
          </summary>
          <div className="mt-5 max-w-2xl space-y-5">
            <p className="text-sm text-muted-foreground">
              Settings apply to your next message. Earlier replies keep the settings that produced
              them.
            </p>
            <ConversationSettingsForm
              key={conversation.id}
              projectId={project.id}
              conversation={conversation}
              sourceSharingAllowed={sourceAccess.current}
            />
            <p className="border-t pt-5 text-sm text-muted-foreground">
              Source-sharing permission is managed in{' '}
              <Link
                href={`/projects/${project.id}/settings#source-sharing`}
                className="text-primary underline underline-offset-4"
              >
                Project Settings
              </Link>
              .
            </p>
          </div>
        </details>
      </section>
      <ConversationViews
        turnActive={active}
        generating={generating}
        chat={
          <ConversationChat
            key={conversation.id}
            composer={{
              projectId: project.id,
              conversationId: conversation.id,
              aiEnabled: ai.enabled,
              turnActive: active,
              proposalsActive: generating,
              target: `${agentRuntimeLabels[conversation.agentRuntime]} · ${model} · ${describeLanguageMode(conversation.languageMode)} · ${conversationContextModeLabels[conversation.contextMode]}`,
            }}
          >
            {ai.enabled && (!projectAware || sourceAccess.current) ? (
              <details className="rounded-lg border p-3 text-sm">
                <summary className="w-fit outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  About AI context and permissions
                </summary>
                <div className="mt-3">{contextNotice}</div>
              </details>
            ) : (
              contextNotice
            )}
            <ConversationHistory
              projectId={project.id}
              conversationId={conversation.id}
              messages={messages}
              turns={turns}
              ai={ai}
              generations={generations}
            />
          </ConversationChat>
        }
        tasks={
          <TaskProposalsPanel
            projectId={project.id}
            conversationId={conversation.id}
            defaultBaseBranch={project.defaultBaseBranch}
            branches={branches}
            generations={generations}
            proposals={proposals}
            aiEnabled={ai.enabled}
            turnActive={active}
          />
        }
        notes={
          <div className="flex min-h-[60dvh] flex-col gap-4">
            <ConversationNotes messages={messages} />
            <Card className="mt-auto">
              <CardContent>
                <MessageComposer
                  key={`notes-${conversation.id}`}
                  mode="note"
                  projectId={project.id}
                  conversationId={conversation.id}
                  aiEnabled={ai.enabled}
                  turnActive={active}
                  proposalsActive={generating}
                  target=""
                />
              </CardContent>
            </Card>
          </div>
        }
      />
    </>
  );
};

export default ConversationPage;
