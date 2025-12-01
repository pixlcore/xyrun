# Overview

**xyOps Remote Job Runner (xyRun)** is a companion to the [xyOps](https://xyops.io) workflow automation and server monitoring platform.  It is a wrapper for running remote jobs inside Docker containers, or over a remote SSH connection.

The idea is that when a job is running "remotely" (i.e. not a direct child process of [xySat](https://github.com/pixlcore/xysat)) then we cannot monitor system resources for the job.  Also, input and output files simply do not work in these cases (because xySat expects them to be on the local filesystem where it is running).  xyRun handles all these complexities for you by sitting "in between" your job and xySat.  xyRun should run *inside* the container or on the far end of the SSH connection, where your job process is running.

To use xyRun in a xyOps Event Plugin, make sure you set the Plugin's `runner` property to `true`.  This hint tells xyOps (and ultimately xySat) that the job is running remotely out if its reach, and it should not perform the usual process and network monitoring, and file management.  Those duties get delegated to xyRun.

## Features

- Handles monitoring processes, network connections, CPU and memory usage of remote jobs, and passing those metrics back to xyOps.
- Handles input files by creating a temporary directory for you job and pre-downloading all files from the xyOps master server.
- Handles output files by intercepting the `files` message and uploading them directly to the xyOps master server.

# Installation

xyRun requires both Node.js LTS and NPM.

## Docker

In your Dockerfile, preinstall Node.js LTS if needed (assuming Ubuntu / Debian base):

```
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash
RUN apt-get update && apt-get install -y nodejs
```

And preinstall xyRun like this:

```
RUN npm install -g @pixlcore/xyrun
```

Then wrap your `CMD` with a `xyrun` prefix like this:

```
CMD xyrun node /path/to/your-script.js
```

xyRun will directly launch whatever is passed to it on the CLI, including arguments.

## Other

For other uses (i.e. SSH) install the NPM module globally on the target machine where the remote job will be running:

```sh
npm install -g @pixlcore/xyrun
```

Then wrap your remote command with a `xyrun` prefix:

```sh
ssh user@target xyrun node /path/to/your-script.js
```

# Development

You can install the source code by using [Git](https://en.wikipedia.org/wiki/Git) ([Node.js](https://nodejs.org/) is also required):

```sh
git clone https://github.com/pixlcore/xyrun.git
cd xyrun
npm install
```

You can then pass it mock job data by issuing a pipe command such as:

```sh
echo '{"xy":1, "runner":true}' | node main.js node your-script-here.js
```

# License

See [LICENSE.md](LICENSE.md) in this repository.
