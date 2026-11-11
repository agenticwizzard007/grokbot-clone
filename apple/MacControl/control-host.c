// Native supervisor: grant the companion bounded cleanup time, then stop only descendants
// whose PID, OS user and process birth time still match an observed owned process.
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc.h>
#else
#include <dirent.h>
#endif

typedef struct {
    pid_t pid, parent;
    uid_t user;
    uint64_t birth, birth_fraction;
} Identity;
typedef struct { Identity *rows; size_t count, capacity; } Processes;
static volatile sig_atomic_t stopping = 0;
static void request_stop(int signal_number) { (void)signal_number; stopping = 1; }
static double monotonic_time(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (double)now.tv_sec + (double)now.tv_nsec / 1000000000.0;
}
static void pause_briefly(void) {
    struct timespec delay = { 0, 20000000 };
    nanosleep(&delay, NULL);
}
static int same_process(Identity a, Identity b) {
    return a.pid == b.pid && a.user == b.user && a.birth == b.birth && a.birth_fraction == b.birth_fraction;
}
static int read_identity(pid_t pid, Identity *identity) {
#ifdef __APPLE__
    struct proc_bsdinfo info;
    int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, (int)sizeof(info));
    if (size != (int)sizeof(info) || info.pbi_status == SZOMB) return 0;
    *identity = (Identity){ pid, (pid_t)info.pbi_ppid, info.pbi_uid, info.pbi_start_tvsec, info.pbi_start_tvusec };
#else
    char name[64], buffer[4096];
    snprintf(name, sizeof(name), "/proc/%ld/stat", (long)pid);
    FILE *file = fopen(name, "r");
    if (!file) return 0;
    struct stat attributes;
    int valid = fstat(fileno(file), &attributes) == 0 && fgets(buffer, sizeof(buffer), file) != NULL;
    fclose(file);
    if (!valid) return 0;
    char *fields = strrchr(buffer, ')'), *state = NULL;
    if (!fields || fields[1] != ' ') return 0;
    fields += 2;
    pid_t parent = 0;
    uint64_t birth = 0;
    char *save = NULL;
    for (int index = 0; index <= 19; index++) {
        char *field = strtok_r(index == 0 ? fields : NULL, " ", &save);
        if (!field) return 0;
        if (index == 0) state = field;
        if (index == 1) parent = (pid_t)strtol(field, NULL, 10);
        if (index == 19) birth = strtoull(field, NULL, 10);
    }
    if (!state || *state == 'Z' || *state == 'X') return 0;
    *identity = (Identity){ pid, parent, attributes.st_uid, birth, 0 };
#endif
    return identity->user == getuid();
}
static void append(Processes *table, Identity identity) {
    if (table->count == table->capacity) {
        size_t capacity = table->capacity ? table->capacity * 2 : 128;
        Identity *rows = realloc(table->rows, capacity * sizeof(*rows));
        if (!rows) { stopping = 1; return; }
        table->rows = rows;
        table->capacity = capacity;
    }
    table->rows[table->count++] = identity;
}
static Processes inventory(void) {
    Processes table = { 0 };
#ifdef __APPLE__
    int capacity = proc_listallpids(NULL, 0) * 2 + 128;
    if (capacity < 128) capacity = 128;
    pid_t *pids = calloc((size_t)capacity, sizeof(*pids));
    if (!pids) { stopping = 1; return table; }
    int count = proc_listallpids(pids, capacity * (int)sizeof(*pids));
    if (count > capacity) count = capacity;
    for (int index = 0; index < count; index++) {
        Identity identity;
        if (pids[index] > 0 && read_identity(pids[index], &identity)) append(&table, identity);
    }
    free(pids);
#else
    DIR *directory = opendir("/proc");
    if (!directory) return table;
    struct dirent *entry;
    while ((entry = readdir(directory))) {
        char *end;
        long pid = strtol(entry->d_name, &end, 10);
        Identity identity;
        if (pid > 0 && *end == '\0' && read_identity((pid_t)pid, &identity)) append(&table, identity);
    }
    closedir(directory);
#endif
    return table;
}
static int contains(Processes *owned, Identity identity) {
    for (size_t index = 0; index < owned->count; index++) if (same_process(owned->rows[index], identity)) return 1;
    return 0;
}
// Retain observed ownership across reparenting. A recycled PID never inherits ownership.
static size_t observe_descendants(Processes *owned) {
    Processes table = inventory();
    for (int changed = 1; changed;) {
        changed = 0;
        for (size_t index = 0; index < table.count; index++) {
            Identity child = table.rows[index];
            if (contains(owned, child)) continue;
            for (size_t parent = 0; parent < table.count; parent++) {
                if (table.rows[parent].pid == child.parent && contains(owned, table.rows[parent])) {
                    size_t before = owned->count;
                    append(owned, child);
                    changed |= owned->count != before;
                    break;
                }
            }
        }
    }
    size_t live = 0;
    for (size_t index = 0; index < table.count; index++) live += contains(owned, table.rows[index]);
    free(table.rows);
    return live;
}
static void signal_owned(Identity identity, int signal_number) {
    Identity current;
    if (identity.pid > 1 && identity.pid != getpid() && read_identity(identity.pid, &current) && same_process(identity, current)) {
        kill(identity.pid, signal_number);
    }
}
static void hard_cleanup(Processes *owned) {
    // Freeze owned parents before taking the final snapshots so a wedged companion cannot
    // fork past the cleanup pass. Never send a group-wide signal to unknown processes.
    for (int pass = 0; pass < 8; pass++) {
        size_t before = owned->count;
        for (size_t index = 0; index < owned->count; index++) signal_owned(owned->rows[index], SIGSTOP);
        observe_descendants(owned);
        if (before == owned->count) break;
    }
    for (size_t index = owned->count; index > 0; index--) signal_owned(owned->rows[index - 1], SIGKILL);
}
static int abort_startup(pid_t child, int gate) {
    close(gate);
    // No exec has been authorized. This is our unreaped direct child, so its PID
    // cannot be recycled and it cannot have launched any unobserved descendants.
    kill(child, SIGKILL);
    while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
    return 126;
}

int main(int argc, char **argv) {
    if (getuid() == 0 || geteuid() != getuid() || argc < 3 || argv[1][0] != '/') {
        fputs("Open Swarm as your signed-in Mac user with its bundled runtime.\n", stderr);
        return 126;
    }
    if (setpgid(0, 0) != 0 && getpgrp() != getpid()) return 126;
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = request_stop;
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGHUP, &action, NULL);
    // A child killed while waiting for permission must not kill the supervisor
    // with SIGPIPE when it attempts to release the startup gate.
    signal(SIGPIPE, SIG_IGN);
    pid_t app = getppid();
    int gate[2];
    if (pipe(gate) != 0) return 126;
    pid_t companion = fork();
    if (companion < 0) { close(gate[0]); close(gate[1]); return 126; }
    if (companion == 0) {
        close(gate[1]);
        // Stay alive before exec until the parent has recorded our identity.
        // EOF (including supervisor death) never authorizes running the payload.
        char approval = 0;
        ssize_t received;
        do { received = read(gate[0], &approval, 1); } while (received < 0 && errno == EINTR && !stopping);
        close(gate[0]);
        if (received != 1 || approval != 1 || stopping) _exit(126);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL);
        signal(SIGPIPE, SIG_DFL);
        if (setpgid(0, 0) != 0 && getpgrp() != getpid()) _exit(126);
        execv(argv[1], &argv[1]);
        _exit(127);
    }
    close(gate[0]);
    Processes owned = { 0 };
    Identity root;
    if (!read_identity(companion, &root)) return abort_startup(companion, gate[1]);
    append(&owned, root);
    if (owned.count != 1 || stopping || getppid() != app) {
        free(owned.rows);
        return abort_startup(companion, gate[1]);
    }
    char approval = 1;
    ssize_t sent;
    do { sent = write(gate[1], &approval, 1); } while (sent < 0 && errno == EINTR && !stopping);
    if (sent != 1) {
        free(owned.rows);
        return abort_startup(companion, gate[1]);
    }
    close(gate[1]);
    int status = 0, reaped = 0, signalled = 0;
    double deadline = 0;
    for (;;) {
        size_t live = observe_descendants(&owned);
        if (!reaped && waitpid(companion, &status, WNOHANG) == companion) reaped = 1;
        if (getppid() != app) stopping = 1;
        if (reaped) {
            // A dead companion cannot perform further cleanup. Reap its known leftovers.
            hard_cleanup(&owned);
            break;
        }
        if (stopping && !signalled) {
            // Capture detached shell/MCP descendants BEFORE asking the companion to exit.
            signalled = 1;
            deadline = monotonic_time() + 2.0;
            signal_owned(root, SIGTERM);
        }
        if (signalled && (live == 0 || monotonic_time() >= deadline)) {
            hard_cleanup(&owned);
            break;
        }
        pause_briefly();
    }
    if (!reaped) {
        // SIGKILL has been delivered; reap only our direct child, never wait on user apps.
        while (waitpid(companion, &status, 0) < 0 && errno == EINTR) {}
    }
    free(owned.rows);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
