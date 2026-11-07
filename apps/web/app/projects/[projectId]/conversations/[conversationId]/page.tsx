import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ArrowLeft, FolderGit2 } from 'lucide-react';
import { conversationContextModeLabels } from '@ai-agent-manager/core';

import { ConversationAutoRefresh } from '@/components/conversations/conversation-auto-refresh';
import { ConversationHistory } from '@/components/conversations/conversation-history';
import { ConversationAiNotice } from '@/components/conversations/conversation-notice';
import { ConversationSettingsForm } from '@/components/conversations/conversation-settings-form';
import { MessageComposer } from '@/components/conversations/message-composer';
import { ProjectSourceAccessCard } from '@/components/conversations/project-source-access-card';
import { TaskProposalsPanel } from '@/components/conversations/task-proposals-panel';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { conversationsUrl, describeLanguageMode } from '@/lib/conversations/format';
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
  return (
    <>
      <ConversationAutoRefresh active={active || generating} />
      <section aria-labelledby="page-title" className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href={conversationsUrl(project.id)}>
            <ArrowLeft aria-hidden="true" />
            {project.name} conversations
          </Link>
        </Button>
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
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
      </section>

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
                ? `With each message, the CLI first chooses files from a list of ${project.name}'s committed files (HEAD of the registered checkout); AI Agent Manager then reads bounded excerpts read-only and sends them to the provider with your message. Sensitive, ignored, dependency and build files are excluded. Uncommitted changes are not included.`
                : 'Allow source sharing for this project in the Settings panel, or switch the conversation to General Chat. Until then, messages are refused and nothing is read.'}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="history-title" className="min-w-0 space-y-4">
          <h2 id="history-title" className="sr-only">
            History
          </h2>
          <ConversationHistory
            projectId={project.id}
            conversationId={conversation.id}
            messages={messages}
            turns={turns}
            ai={ai}
            generations={generations}
          />
          <Card>
            <CardContent>
              <MessageComposer
                projectId={project.id}
                conversationId={conversation.id}
                aiEnabled={ai.enabled}
                turnActive={active}
                proposalsActive={generating}
                target={`${agentRuntimeLabels[conversation.agentRuntime]} · ${model} · ${describeLanguageMode(conversation.languageMode)} · ${conversationContextModeLabels[conversation.contextMode]}`}
              />
            </CardContent>
          </Card>
          <TaskProposalsPanel
            projectId={project.id}
            conversationId={conversation.id}
            defaultBaseBranch={project.defaultBaseBranch}
            branches={branches}
            generations={generations}
            proposals={proposals}
          />
        </section>

        <Card className="lg:sticky lg:top-6">
          <CardHeader>
            <CardTitle>
              <h2>Settings</h2>
            </CardTitle>
            <CardDescription>
              Used for the next message sent to the AI. Earlier messages and replies keep the
              settings that produced them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <ConversationSettingsForm
              projectId={project.id}
              conversation={conversation}
              sourceSharingAllowed={sourceAccess.current}
            />
            {projectAware || sourceAccess.access === 'allowed' ? (
              <div className="border-t pt-5">
                <ProjectSourceAccessCard
                  projectId={project.id}
                  projectName={project.name}
                  sourceAccess={sourceAccess}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
};

export default ConversationPage;
