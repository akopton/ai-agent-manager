import Link from 'next/link';
import { Columns3, LayoutDashboard, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const plannedAreas = [
  {
    title: 'Project boards',
    icon: Columns3,
    description: 'Give each task a clear next step.',
    detail: 'Organize work from backlog through execution and review on a dedicated project board.',
  },
  {
    title: 'Overview',
    icon: LayoutDashboard,
    description: 'See the bigger picture across projects.',
    detail: 'Follow queued work, active runs, and changes waiting for your review.',
  },
];

const HomePage = () => (
  <>
    <section
      aria-labelledby="page-title"
      className="flex flex-wrap items-start justify-between gap-4"
    >
      <div>
        <p className="mb-2 text-sm text-muted-foreground">Your development workspace</p>
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight">
          Overview
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          A home for your projects, coding tasks, and reviews.
        </p>
      </div>
      <Badge variant="secondary">Preview</Badge>
    </section>

    <Card className="gap-6 p-2 sm:p-4">
      <CardHeader>
        <CardTitle>
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
            A clear space for your next task
          </h2>
        </CardTitle>
        <CardDescription className="max-w-2xl leading-6">
          Coordinate work across local repositories and review agent changes before publishing.
          Start by adding a local repository; task management is coming next.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        <Button asChild size="lg">
          <Link href="/projects/new">
            <Plus aria-hidden="true" />
            Add project
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/projects">View projects</Link>
        </Button>
      </CardContent>
    </Card>

    <section aria-labelledby="planned-areas" className="space-y-4">
      <h2 id="planned-areas" className="text-sm font-semibold">
        Coming next
      </h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {plannedAreas.map(({ title, icon: Icon, description, detail }) => (
          <Card key={title} className="h-full">
            <CardHeader className="gap-3">
              <div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-muted">
                <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
              </div>
              <CardTitle>
                <h3>{title}</h3>
              </CardTitle>
              <CardDescription className="leading-6">{description}</CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              <p className="text-sm leading-6 text-muted-foreground">{detail}</p>
            </CardContent>
            <CardFooter>
              <Badge variant="outline">Coming soon</Badge>
            </CardFooter>
          </Card>
        ))}
      </div>
    </section>
  </>
);

export default HomePage;
