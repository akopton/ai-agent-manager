// Trusted, bounded source reader. No repository executable, filter or shell is invoked.
// Arguments are supplied by the worker, never by the model: root, dev, ino, relative path, limit.
#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_SOURCE_BYTES (512 * 1024)
#define READ_FLAGS (O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)

static int valid_component(const char *part) {
  if (!*part || !strcmp(part, ".") || !strcmp(part, "..") || !strcasecmp(part, ".git")) return 0;
  for (const unsigned char *p = (const unsigned char *)part; *p; p++) {
    if (*p < 32 || *p == 127 || *p == '\\' || *p == ':') return 0;
  }
  return 1;
}

// Every lookup is relative to an already opened directory, with no-follow on every component.
// Root is opened by the same walk starting at '/', then bound to the expected device/inode.
static int walk(int base, const char *path, int directory) {
  if (!*path || *path == '/' || strlen(path) > 4096) return -1;
  char *copy = strdup(path);
  if (!copy) return -1;
  int current = dup(base);
  char *part = copy;
  while (current >= 0) {
    char *slash = strchr(part, '/');
    if (slash) *slash = 0;
    if (!valid_component(part)) { close(current); current = -1; break; }
    int next = openat(current, part, READ_FLAGS | ((slash || directory) ? O_DIRECTORY : 0));
    close(current);
    current = next;
    if (!slash) break;
    part = slash + 1;
  }
  free(copy);
  return current;
}

static int same_file(const struct stat *a, const struct stat *b) {
#ifdef __APPLE__
  int times_equal = a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec &&
    a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
    a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec &&
    a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
#else
  int times_equal = a->st_mtim.tv_sec == b->st_mtim.tv_sec &&
    a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
    a->st_ctim.tv_sec == b->st_ctim.tv_sec &&
    a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
#endif
  return times_equal && a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
    a->st_mode == b->st_mode && a->st_size == b->st_size;
}

static int number(const char *value, uintmax_t *out) {
  if (!*value) return 0;
  for (const char *p = value; *p; p++) if (*p < '0' || *p > '9') return 0;
  char *end;
  errno = 0;
  *out = strtoull(value, &end, 10);
  return !errno && !*end;
}

int main(int argc, char **argv) {
  uintmax_t dev, ino, limit;
  if (argc != 6 || argv[1][0] != '/' || !number(argv[2], &dev) ||
      !number(argv[3], &ino) || !number(argv[5], &limit) || !limit || limit > MAX_SOURCE_BYTES) return 2;
  int slash = open("/", READ_FLAGS | O_DIRECTORY);
  if (slash < 0) return 3;
  int root = walk(slash, argv[1] + 1, 1);
  close(slash);
  struct stat root_stat, before, after, named;
  if (root < 0 || fstat(root, &root_stat) || (uintmax_t)root_stat.st_dev != dev ||
      (uintmax_t)root_stat.st_ino != ino) return 3;
  int file = walk(root, argv[4], 0);
  if (file < 0 || fstat(file, &before) || !S_ISREG(before.st_mode) ||
      before.st_size < 0 || (uintmax_t)before.st_size > limit) return 4;
  unsigned char *bytes = malloc((size_t)limit + 1);
  if (!bytes) return 5;
  size_t size = 0;
  while (size <= limit) {
    ssize_t count = read(file, bytes + size, (size_t)limit + 1 - size);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return 5;
    if (count == 0) break;
    size += (size_t)count;
  }
  if (size > limit || size != (uintmax_t)before.st_size || fstat(file, &after) ||
      !same_file(&before, &after)) return 6;
  int current = walk(root, argv[4], 0);
  if (current < 0 || fstat(current, &named) || !same_file(&after, &named)) return 6;
  // No source leaves the helper until all checks pass. The parent rechecks repository identity.
  close(current);
  close(file);
  close(root);
  size_t sent = 0;
  while (sent < size) {
    ssize_t count = write(STDOUT_FILENO, bytes + sent, size - sent);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 5;
    sent += (size_t)count;
  }
  free(bytes);
  return 0;
}
