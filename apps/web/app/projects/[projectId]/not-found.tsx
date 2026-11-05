import Link from 'next/link';
import { SearchX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const ProjectNotFound = () => (
  <Card className="items-center px-6 py-12 text-center">
    <SearchX className="size-8 text-muted-foreground" aria-hidden="true" />
    <CardHeader className="w-full max-w-md justify-items-center">
      <CardTitle>
        <h1 className="text-lg font-semibold">Project not found</h1>
      </CardTitle>
      <CardDescription>This project does not exist or is no longer registered.</CardDescription>
    </CardHeader>
    <CardContent>
      <Button asChild variant="outline">
        <Link href="/projects">All projects</Link>
      </Button>
    </CardContent>
  </Card>
);

export default ProjectNotFound;
