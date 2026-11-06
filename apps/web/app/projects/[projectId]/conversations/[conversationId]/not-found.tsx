import Link from 'next/link';
import { SearchX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const ConversationNotFound = () => (
  <Card className="items-center px-6 py-12 text-center">
    <SearchX className="size-8 text-muted-foreground" aria-hidden="true" />
    <CardHeader className="w-full max-w-md justify-items-center">
      <CardTitle>
        <h1 className="text-lg font-semibold">Conversation not found</h1>
      </CardTitle>
      <CardDescription>This conversation does not exist in this project.</CardDescription>
    </CardHeader>
    <CardContent>
      <Button asChild variant="outline">
        <Link href="/conversations">All conversations</Link>
      </Button>
    </CardContent>
  </Card>
);

export default ConversationNotFound;
