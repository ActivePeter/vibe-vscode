/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <string.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/** A plugin owns the process tree it starts, including after its Node host is killed. */
static long long monotonic_milliseconds(void) {
	struct timespec now;
	if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
		_exit(125);
	}
	return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

/** No PID files, port lookup, shell parsing, or attachment to an existing process. */
int main(int argc, char **argv) {
	if (argc < 2) {
		return 125;
	}
	pid_t owner = getppid();
	int lease = -1;
	int command = 1;
	if (strcmp(argv[1], "--lease-directory") == 0) {
		if (argc < 4) {
			return 125;
		}
		lease = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
		if (lease < 0) {
			return 123;
		}
		if (flock(lease, LOCK_EX | LOCK_NB) != 0) {
			return errno == EWOULDBLOCK ? 124 : 123;
		}
		command = 3;
	}
	sigset_t signals;
	sigset_t previous;
	sigemptyset(&signals);
	sigaddset(&signals, SIGCHLD);
	sigaddset(&signals, SIGTERM);
	sigaddset(&signals, SIGINT);
	sigaddset(&signals, SIGHUP);
	if (sigprocmask(SIG_BLOCK, &signals, &previous) != 0
		|| prctl(PR_SET_CHILD_SUBREAPER, 1) != 0
		|| prctl(PR_SET_PDEATHSIG, SIGTERM) != 0
		|| owner == 1 || getppid() != owner) {
		return 125;
	}
	int notifications = signalfd(-1, &signals, SFD_CLOEXEC | SFD_NONBLOCK);
	if (notifications < 0) {
		return 125;
	}
	pid_t child = fork();
	if (child < 0) {
		return 125;
	}
	if (child == 0) {
		pid_t supervisor = getppid();
		if (setpgid(0, 0) != 0 || prctl(PR_SET_PDEATHSIG, SIGKILL) != 0
			|| supervisor == 1 || getppid() != supervisor
			|| sigprocmask(SIG_SETMASK, &previous, NULL) != 0) {
			_exit(125);
		}
		close(notifications);
		if (lease >= 0) {
			close(lease);
		}
		execvp(argv[command], argv + command);
		_exit(127);
	}
	/** Close the parent's duplicate IPC fd so the actual Node child owns channel lifetime. */
	const char *channel = getenv("NODE_CHANNEL_FD");
	if (channel) {
		char *end = NULL;
		long fd = strtol(channel, &end, 10);
		if (end && *end == '\0' && fd > STDERR_FILENO && fd != notifications) {
			close((int)fd);
		}
	}
	/** The child also sets its group before exec; either side may win this race. */
	if (setpgid(child, child) != 0 && errno != EACCES && errno != ESRCH) {
		kill(child, SIGKILL);
	}
	long long deadline = 0;
	int status = 125 << 8;
	for (;;) {
		siginfo_t exited = { 0 };
		if (waitid(P_PID, child, &exited, WEXITED | WNOHANG | WNOWAIT) == 0 && exited.si_pid == child) {
			/** Keep the leader unreaped until the group is signalled: its ID cannot be reused. */
			kill(-child, SIGKILL);
			while (waitpid(child, &status, 0) < 0 && errno == EINTR) { }
			break;
		}
		if (deadline && monotonic_milliseconds() >= deadline) {
			kill(-child, SIGKILL);
		}
		struct pollfd poll_descriptor = { .fd = notifications, .events = POLLIN };
		if (poll(&poll_descriptor, 1, 100) < 0 && errno != EINTR) {
			kill(-child, SIGKILL);
		}
		struct signalfd_siginfo notification;
		while (read(notifications, &notification, sizeof(notification)) == sizeof(notification)) {
			if (notification.ssi_signo != SIGCHLD && !deadline) {
				deadline = monotonic_milliseconds() + 3000;
				kill(-child, SIGTERM);
			}
		}
	}
	/** Reap adopted descendants; each nested supervisor handles its own process group. */
	while (waitpid(-1, NULL, 0) >= 0 || errno == EINTR) { }
	close(notifications);
	if (lease >= 0) {
		close(lease);
	}
	return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
