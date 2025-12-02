#!/usr/bin/env node

// xyRun - xyOps Remote Job Runner - Main entry point
// Copyright (c) 2019 - 2025 PixlCore LLC
// BSD 3-Clause License -- see LICENSE.md

const Path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const JSONStream = require('pixl-json-stream');
const PixlRequest = require('pixl-request');
const Tools = require('pixl-tools');
const pkg = require('./package.json');

const noop = function() {};
const async = Tools.async;

process.title = "xyRun";

const app = {
	
	activeJobs: {},
	kids: {},
	procCache: {},
	connCache: {},
	
	async run() {
		// read job from stdin
		const chunks = [];
		for await (const chunk of process.stdin) { chunks.push(chunk); }
		this.job = JSON.parse( chunks.join('') );
		
		// create a http request instance for various tasks
		this.request = new PixlRequest( "xyOps Job Runner v" + pkg.version );
		this.request.setTimeout( 300 * 1000 );
		this.request.setFollow( 5 );
		this.request.setAutoError( true );
		this.request.setKeepAlive( true );
		
		// prime this for repeated calls	
		this.numCPUs = os.cpus().length;
		
		// sniff platform
		this.platform = {};
		switch (process.platform) {
			case 'linux': this.platform.linux = true; break;
			case 'darwin': this.platform.darwin = true; break;
			case 'freebsd': case 'openbsd': case 'netbsd': this.platform.bsd = true; break;
			case 'win32': this.platform.windows = true; break;
		}
		
		if (this.platform.linux) {
			// pre-calc location of some binaries
			this.psBin = Tools.findBinSync('ps');
			this.ssBin = Tools.findBinSync('ss');
		} // linux
		
		if (this.platform.darwin) {
			// pre-calc location of some binaries
			this.psBin = Tools.findBinSync('ps');
		} // darwin
		
		// launch child process
		this.prepLaunchJob();
		
		// start ticker
		this.timer = setInterval( this.tick.bind(this), 1000 );
	},
	
	prepLaunchJob() {
		// setup temp dir for job, and download any files passed to us
		var self = this;
		var job = this.job;
		
		// no input files?  skip prep, and no temp dir needed
		if (!job.input || !job.input.files || !job.input.files.length) {
			this.launchJob();
			return;
		}
		
		async.series([
			function(callback) {
				// create temp dir for job, full access
				Tools.mkdirp( job.cwd, { mode: 0o777 }, callback );
			},
			function(callback) {
				// download input files to job temp dir if we were given any
				async.eachSeries( job.input.files,
					function(file, callback) {
						var dest_file = Path.join( job.cwd, file.filename );
						var url = job.base_url + '/' + file.path;
						var opts = Tools.mergeHashes( job.socket_opts || {}, {
							download: dest_file
						});
						
						console.log( `Downloading file: ${dest_file} (${Tools.getTextFromBytes(file.size)})` );
						
						self.request.get( url, opts, function(err, resp, data, perf) {
							if (err) {
								return callback( new Error("Failed to download job file: " + file.filename + ": " + (err.message || err)) );
							}
							callback();
						} ); // request.get
					},
					callback
				); // eachSeries
			}
		],
		function(err) {
			if (err) {
				// something went wrong
				job.pid = 0;
				job.code = 1;
				job.description = "Runner: " + err;
				console.error(job.description);
				self.activeJobs[ job.id ] = job;
				self.finishJob( job );
				return;
			}
			
			// launch job for real
			self.launchJob();
		});
	},
	
	launchJob() {
		// launch job on this server!
		var self = this;
		var job = this.job;
		var child = null;
		var worker = {};
		
		// setup environment for child
		var child_args = process.argv.slice(2);
		var child_cmd = child_args.shift();
		var child_opts = {
			env: Object.assign( {}, process.env, job.secrets || {} )
		};
		
		child_opts.env['XYOPS'] = 'runner-' + pkg.version;
		child_opts.env['JOB_ID'] = job.id;
		child_opts.env['JOB_NOW'] = job.now;
		
		if (!child_cmd && job.params && job.params.script) {
			// no direct command specified, but user wants a "script" executed from the job params
			var script_file = Path.join( job.cwd, 'xyops-script-temp-' + job.id + '.sh' );
			child_cmd = Path.resolve(script_file);
			child_args = [];
			
			// quickly write out script file and make it executable
			Tools.mkdirpSync( job.cwd, { mode: 0o777 } );
			fs.writeFileSync( script_file, job.params.script.replace(/\r\n/g, "\n"), { mode: 0o775 } );
			
			// set the cwd to the job cwd, as it's a more controlled environment
			child_opts.cwd = job.cwd;
		}
		
		if (!child_cmd) {
			// no command!
			job.pid = 0;
			job.code = 1;
			job.description = "Runner: No command specified.";
			console.error(job.description);
			self.activeJobs[ job.id ] = job;
			self.finishJob();
			return;
		}
		if (!job.runner) {
			// not in runner mode
			job.pid = 0;
			job.code = 1;
			job.description = "Job not launched in runner mode (Set runner flag in event plugin).";
			console.error(job.description);
			self.activeJobs[ job.id ] = job;
			self.finishJob();
			return;
		}
		
		console.log( "Running command: " + child_cmd, child_args );
		
		// get uid / gid info for child env vars
		if (!this.platform.windows) {
			child_opts.uid = job.uid || process.getuid();
			child_opts.gid = process.getgid();
			
			var user_info = Tools.getpwnam( child_opts.uid, true );
			if (user_info) {
				child_opts.uid = user_info.uid;
				child_opts.gid = user_info.gid;
				child_opts.env.USER = child_opts.env.USERNAME = user_info.username;
				child_opts.env.HOME = user_info.dir;
				child_opts.env.SHELL = user_info.shell;
			}
			else if (child_opts.uid != process.getuid()) {
				// user not found
				job.pid = 0;
				job.code = 1;
				job.description = "Plugin Error: User does not exist: " + child_opts.uid;
				console.error(job.description);
				this.activeJobs[ job.id ] = job;
				this.finishJob();
				return;
			}
			
			if (job.gid) {
				var grp_info = Tools.getgrnam( job.gid, true );
				if (grp_info) {
					child_opts.gid = grp_info.gid;
				}
				else {
					// gid not found
					job.pid = 0;
					job.code = 1;
					job.description = "Plugin Error: Group does not exist: " + job.gid;
					console.error(job.description);
					this.activeJobs[ job.id ] = job;
					this.finishJob();
					return;
				}
			}
			
			child_opts.uid = parseInt( child_opts.uid );
			child_opts.gid = parseInt( child_opts.gid );
		}
		
		// add plugin params as env vars, expand $INLINE vars
		if (job.params) {
			for (var key in job.params) {
				child_opts.env[ key.replace(/\W+/g, '_') ] = 
					(''+job.params[key]).replace(/\$(\w+)/g, function(m_all, m_g1) {
					return (m_g1 in child_opts.env) ? child_opts.env[m_g1] : '';
				});
			}
		}
		
		// windows additions
		if (this.platform.windows) {
			child_opts.windowsHide = true;
		}
		
		// attach streams
		child_opts.stdio = ['pipe', 'pipe', 'inherit'];
		
		// spawn child
		try {
			child = cp.spawn( child_cmd, child_args, child_opts );
			if (!child || !child.pid || !child.stdin || !child.stdout) {
				throw new Error("Child process failed to spawn (Check executable location and permissions?)");
			}
		}
		catch (err) {
			if (child) child.on('error', function() {}); // prevent crash
			job.pid = 0;
			job.code = 1;
			job.description = "Runner: Child spawn error: " + child_cmd + ": " + Tools.getErrorDescription(err);
			console.error(job.description);
			this.activeJobs[ job.id ] = job;
			this.finishJob();
			return;
		}
		job.pid = child.pid || 0;
		
		// connect json stream to child's stdio
		// order reversed deliberately (out, in)
		var stream = new JSONStream( child.stdout, child.stdin );
		stream.recordRegExp = /^\s*\{.+\}\s*$/;
		stream.preserveWhitespace = true;
		stream.maxLineLength = 1024 * 1024;
		stream.EOL = "\n";
		
		worker.pid = job.pid;
		worker.child = child;
		worker.stream = stream;
		this.worker = worker;
		
		stream.on('json', function(data) {
			// received data from child
			if (!self.handleChildResponse(job, worker, data)) {
				// unrecognized json, emit as raw text
				stream.emit('text', JSON.stringify(data) + "\n");
			}
		} );
		
		stream.on('text', function(line) {
			// received non-json text from child, log it
			if (self.platform.windows) line = line.replace(/\r$/, '');
			process.stdout.write(line);
		} );
		
		stream.on('error', function(err, text) {
			// Probably a JSON parse error (child emitting garbage)
			console.error( "Child stream error: Job ID " + job.id + ": PID " + job.pid + ": " + err );
			if (text) process.stdout.write(text);
		} );
		
		child.on('error', function (err) {
			// child error
			job.code = 1;
			job.description = "Runner: Child process error: " + Tools.getErrorDescription(err);
			worker.child_exited = true;
			console.error(job.description);
			self.finishJob();
		} );
		
		child.on('close', function (code, signal) {
			// child exited
			if (code || signal) {
				console.error( "Child exited with code: " + (code || signal) );
			}
			worker.child_exited = true;
			self.finishJob();
		} ); // on exit
		
		// pass job to child
		worker.child.stdin.write( JSON.stringify(job) + "\n" );
		
		// we're done writing to the child -- don't hold its stdin open
		worker.child.stdin.end();
		
		// track job in our own hash
		this.activeJobs[ job.id ] = job;
		this.kids[ job.pid ] = worker;
	},
	
	handleChildResponse(job, worker, data) {
		// intercept child responses, handle files and completion ourselves
		if (!data.xy) return false;
		Tools.mergeHashInto( job, data );
		
		// intecept complete/code, as we need to handle it here after file uploads
		if ('code' in data) delete data.code;
		if ('description' in data) delete data.description;
		if ('complete' in data) delete data.complete;
		
		if (data.files) {
			// remove from job update for parent, as we'll handle this here
			delete data.files;
		}
		else if (data.push && data.push.files) {
			// carefully extract files out of push update
			if (!job.files) job.files = [];
			job.files = job.files.concat( data.push.files );
			delete data.push.files;
			if (!Tools.numKeys(data.push)) delete data.push;
		}
		
		// passthrough other data if present
		var updates = Tools.copyHashRemoveKeys(data, { xy:1 });
		return !Tools.numKeys(updates);
	},
	
	abortJob() {
		// send kill signal if child is active
		console.error(`Caught abort signal, shutting down`);
		
		var job = this.job;
		var worker = this.worker;
		
		if (!job || !worker) process.exit(0);
		
		if (worker.child) {
			// kill process(es) or not, depending on abort policy
			if (job.kill === 'none') {
				// kill none, just unref and finish
				worker.child.unref();
				this.finishJob();
				return;
			}
			
			worker.kill_timer = setTimeout( function() {
				// child didn't die, kill with prejudice
				if ((job.kill === 'all') && job.procs && Tools.firstKey(job.procs)) {
					// sig-kill ALL job processes
					var pids = Object.keys(job.procs);
					console.error( "Children did not exit, killing harder: " + pids.join(', '));
					pids.forEach( function(pid) {
						try { process.kill(pid, 'SIGKILL'); }
						catch(e) {;}
					} );
				}
				else {
					// sig-kill parent only
					console.error( "Child did not exit, killing harder: " + job.pid);
					worker.child.kill('SIGKILL');
				}
			}, 10000 );
			
			// try killing nicely first
			if ((job.kill === 'all') && job.procs && Tools.firstKey(job.procs)) {
				// sig-term ALL job processes
				var pids = Object.keys(job.procs);
				console.log( "Killing all job processes: " + pids.join(', '));
				pids.forEach( function(pid) {
					try { process.kill(pid, 'SIGTERM'); }
					catch(e) {;}
				} );
			}
			else {
				// sig-term parent only
				console.log( "Killing job process: " + job.pid);
				worker.child.kill('SIGTERM');
			}
		}
		else process.exit(0);
	},
	
	finishJob() {
		// upload files
		var self = this;
		var job = this.job;
		var worker = this.worker;
		
		if (!job || !worker) return this.shutdown(); // sanity
		
		if (worker.kill_timer) {
			clearTimeout( worker.kill_timer );
			delete worker.kill_timer;
		}
		
		delete this.job;
		delete this.worker;
		
		this.activeJobs = {};
		this.kids = {};
		
		this.prepUploadJobFiles(job, function(err) {
			if (err) {
				job.code = err.code || 'upload';
				job.description = "Runner: " + (err.message || err);
			}
			
			// did we upload files?  if so, send the metadata along now
			if (job.files && job.files.length) {
				console.log( JSON.stringify({ xy: 1, files: job.files }) );
			}
			
			// now we're done done with job -- send final update
			console.log( JSON.stringify({ xy: 1, complete: true, code: job.code || 0, description: job.description || "" }) );
			
			// delete temp dir
			if (job.cwd) Tools.rimraf( job.cwd, noop );
			
			// all done
			self.shutdown();
		});
	},
	
	prepUploadJobFiles(job, callback) {
		// glob all file requests to resolve them to individual files, then upload
		var self = this;
		var to_upload = [];
		if (!job.files || !job.files.length || !Tools.isaArray(job.files)) return callback();
		
		async.eachSeries( job.files,
			function(file, callback) {
				if (typeof(file) == 'string') {
					file = { path: file };
				}
				else if (Array.isArray(file)) {
					if (file.length == 3) file = { path: file[0], filename: file[1], delete: file[2] };
					else if (file.length == 2) file = { path: file[0], filename: file[1] };
					else file = { path: file[0] };
				}
				
				if (!file.path) return; // sanity
				
				if (file.filename) {
					// if user specified a custom filename, then do not perform a glob
					to_upload.push(file);
					process.nextTick(callback);
				}
				else Tools.glob( file.path, function(err, files) {
					if (!files) files = [];
					files.forEach( function(path) {
						to_upload.push({ path: path, delete: !!file.delete });
					} );
					callback();
				} );
			},
			function() {
				job.files = to_upload;
				self.uploadJobFiles(job, callback);
			}
		); // eachSeries
	},
	
	uploadJobFiles(job, callback) {
		// upload all job files (from user) if applicable
		var self = this;
		var final_files = [];
		
		if (!job.files || !job.files.length || !Tools.isaArray(job.files)) return callback();
		
		if (!job.base_url) {
			console.error("Error: Cannot upload files: Missing 'base_url' property in job data.");
			return callback();
		}
		if (!job.auth_token) {
			console.error("Error: Cannot upload files: Missing 'auth_token' property in job data.");
			return callback();
		}
		
		async.eachSeries( job.files,
			function(file, callback) {
				var filename = Path.basename(file.filename || file.path).replace(/[^\w\-\+\.\,\s\(\)\[\]\{\}\'\"\!\&\^\%\$\#\@\*\?\~]+/g, '_');
				console.log( "Uploading file: " + filename );
				
				var url = job.base_url + '/api/app/upload_job_file';
				var opts = Tools.mergeHashes( job.socket_opts || {}, {
					"files": {
						file1: [file.path, filename]
					},
					"data": {
						id: job.id,
						server: job.server,
						auth: job.auth_token
					}
				});
				
				self.request.post( url, opts, function(err, resp, data, perf) {
					if (err) {
						return callback( new Error("Failed to upload job file: " + filename + ": " + (err.message || err)) );
					}
					
					var json = null;
					try { json = JSON.parse( data.toString() ); }
					catch (err) { return callback(err); }
					
					if (json.code && json.description) {
						return callback( new Error("Failed to upload job file: " + filename + ": " + json.description) );
					}
					
					// save file metadata
					final_files.push({ 
						id: file.id || Tools.generateShortID('f'),
						date: Tools.timeNow(true),
						filename: filename, 
						path: json.key, 
						size: json.size, 
						server: job.server, 
						job: job.id 
					});
					
					if (file.delete) fs.unlink(file.path, callback);
					else return callback();
				}); // request.post
			},
			function(err) {
				// replace job.files with storage keys
				if (err) console.error(err);
				else job.files = final_files;
				callback(err);
			}
		);
	},
	
	tick() {
		// called every second
		// monitor job processes
		this.jobTick();
	},
	
	jobTick() {
		// called every second
		var self = this;
		if (!this.job) return;
		
		if (this.jobTickInProgress) return; // no steppy on toesy
		this.jobTickInProgress = true;
		
		// scan all processes on machine
		// si.processes( function(data) {
		this.getProcsCached( function(data) {
			if (!self.job) {
				self.jobTickInProgress = false;
				return;
			}
			
			// cleanup and convert to hash of pids
			var pids = {};
			data.list.forEach( function(proc) {
				// proc.started = (new Date( proc.started )).getTime() / 1000;
				// proc.memRss = proc.memRss * 1024;
				// proc.memVsz = proc.memVsz * 1024;
				pids[ proc.pid ] = proc;
			} );
			
			for (var job_id in self.activeJobs) {
				var job = self.activeJobs[job_id];
				self.measureJobResources(job, pids);
			}
			
			async.parallel(
				[
					self.measureJobDiskIO.bind(self),
					self.measureJobNetworkIO.bind(self)
				],
				function() {
					if (!self.job) {
						self.jobTickInProgress = false;
						return;
					}
					
					// update job data with stats in tow
					console.log( JSON.stringify({ xy: 1, rpid: process.pid, procs: job.procs, conns: job.conns, cpu: job.cpu, mem: job.mem }) );
					
					self.jobTickInProgress = false;
				}
			); // async.parallel
		} ); // si.processes
	},
	
	measureJobResources(job, pids) {
		// scan process list for all processes that are descendents of job pid
		delete job.procs;
		var root_pid = process.pid;
		
		if (pids[ root_pid ]) {
			// add all procs into job
			job.procs = {};
			job.procs[ root_pid ] = pids[ root_pid ];
			
			var info = pids[ root_pid ];
			var cpu = info.cpu;
			var mem = info.memRss;
			
			// also consider children of the child (up to 100 generations deep)
			var levels = 0;
			var family = {};
			family[ root_pid ] = 1;
			
			while (Tools.numKeys(family) && (++levels <= 100)) {
				for (var fpid in family) {
					for (var cpid in pids) {
						if (pids[ cpid ].parentPid == fpid) {
							family[ cpid ] = 1;
							cpu += pids[ cpid ].cpu;
							mem += pids[ cpid ].memRss;
							job.procs[ cpid ] = pids[ cpid ];
						} // matched
					} // cpid loop
					delete family[fpid];
				} // fpid loop
			} // while
			
			if (job.cpu) {
				if (cpu < job.cpu.min) job.cpu.min = cpu;
				if (cpu > job.cpu.max) job.cpu.max = cpu;
				job.cpu.total += cpu;
				job.cpu.count++;
				job.cpu.current = cpu;
			}
			else {
				job.cpu = { min: cpu, max: cpu, total: cpu, count: 1, current: cpu };
			}
			
			if (job.mem) {
				if (mem < job.mem.min) job.mem.min = mem;
				if (mem > job.mem.max) job.mem.max = mem;
				job.mem.total += mem;
				job.mem.count++;
				job.mem.current = mem;
			}
			else {
				job.mem = { min: mem, max: mem, total: mem, count: 1, current: mem };
			}
		} // matched job with pid
	},
	
	measureJobDiskIO(callback) {
		// use linux /proc/PID/io to glean disk r/w per sec per job proc
		var self = this;
		var procs = [];
		
		// zero everything out for non-linux
		for (var job_id in this.activeJobs) {
			var job = this.activeJobs[job_id];
			if (job.procs) {
				for (var pid in job.procs) { job.procs[pid].disk = 0; }
			}
		}
		
		// this trick is linux only
		if (process.platform != 'linux') return process.nextTick( callback );
		
		// get array of all active job procs
		for (var job_id in this.activeJobs) {
			var job = this.activeJobs[job_id];
			if (job.procs) procs = procs.concat( Object.values(job.procs) );
		}
		
		// parallelize this just a smidge, as it can be a lot of reads
		async.eachLimit( procs, 4,
			function(proc, callback) {
				fs.readFile( '/proc/' + proc.pid + '/io', 'utf8', function(err, text) {
					// if (!text) text = "rchar: " + Math.floor( Tools.timeNow(true) * 1024 ); // sample data (for testing)
					if (!text) text = "";
					
					// parse into key/value pairs
					var params = {};
					text.replace( /(\w+)\:\s*(\d+)/g, function(m_all, key, value) {
						params[key] = parseInt(value);
						return m_all;
					} );
					
					// take disk w + r per proc
					proc.disk = (params.rchar || 0) + (params.wchar || 0);
					// proc.disk = (params.read_bytes || 0) + (params.write_bytes || 0);
					
					callback();
				} );
			},
			callback
		); // async.eachLimit
	},
	
	measureJobNetworkIO(callback) {
		// use linux `ss` utility to glean network r/w per sec per job proc
		var self = this;
		
		// zero everything out for non-linux
		for (var job_id in this.activeJobs) {
			var job = this.activeJobs[job_id];
			if (job.procs) {
				for (var pid in job.procs) { 
					job.procs[pid].conns = 0; 
					job.procs[pid].net = 0; 
				}
			}
		}
		
		// this trick is linux only
		if ((process.platform != 'linux') || !this.ssBin) return process.nextTick( callback );
		
		cp.exec( this.ssBin + ' -nutipaO', { timeout: 1000, maxBuffer: 1024 * 1024 * 32 }, function(err, stdout, stderr) {
			if (err) {
				console.error("Failed to launch ss: " + err);
				return callback();
			}
			
			var now = Tools.timeNow(true);
			var lines = stdout.split(/\n/);
			var ids = {};
			
			lines.forEach( function(line) {
				if (line.match(/^(tcp|tcp4|tcp6|udp|udp4|udp6)\s+(\w+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+.+pid\=(\d+)/)) {
					var type = RegExp.$1, state = RegExp.$2, local_addr = RegExp.$5, remote_addr = RegExp.$6, pid = RegExp.$7;
					
					// clean up some stuff
					pid = parseInt(pid);
					if (state == "ESTAB") state = 'ESTABLISHED';
					if (state == "UNCONN") state = 'UNCONNECTED';
					
					// generate socket "id" key using combo of local + remote
					var id = local_addr + '|' + remote_addr;
					
					if (!self.connCache[id]) self.connCache[id] = { bytes: 0, delta: 0, started: now };
					var conn = self.connCache[id];
					
					conn.type = type;
					conn.state = state;
					conn.local_addr = local_addr;
					conn.remote_addr = remote_addr;
					conn.pid = pid;
					
					var bytes = 0;
					if (line.match(/\bbytes_acked\:(\d+)/)) bytes += parseInt( RegExp.$1 ); // tx
					if (line.match(/\bbytes_received\:(\d+)/)) bytes += parseInt( RegExp.$1 ); // rx
					
					conn.delta = bytes - conn.bytes;
					conn.bytes = bytes;
					
					ids[id] = 1;
				}
			} ); // foreach line
			
			// delete sweep for removed conns
			for (var id in self.connCache) {
				if (!(id in ids)) delete self.connCache[id];
			}
			
			// join up conns with jobs and job procs
			Object.values(self.activeJobs).forEach( function(job) {
				if (!job.procs) return;
				
				job.conns = [];
				for (var id in self.connCache) {
					var conn = self.connCache[id];
					if (conn.pid in job.procs) {
						job.conns.push(conn);
						job.procs[conn.pid].conns++;
						job.procs[conn.pid].net += conn.delta;
					}
				}
				
			}); // foreach job
			
			callback();
		} ); // cp.exec
	},
	
	getProcsCached(callback) {
		// get process information, cached with a dynamic rolling debounce
		// (TTL is based on the previous cache miss elapsed time)
		// (designed to throttle on slower machines, or with thousands of processes)
		var self = this;
		var now = Tools.timeNow();
		var cache = this.procCache;
		
		if (cache.data) {
			if (now < cache.expires) {
				// still fresh
				return callback( Tools.copyHash(cache.data, true) );
			}
		}
		
		this.getProcsFast( function(data) {
			// save cache data
			cache.data = data;
			cache.date = Tools.timeNow();
			cache.elapsed = cache.date - now;
			cache.expires = cache.date + (cache.elapsed * 5);
			callback( Tools.copyHash(cache.data, true) );
		} );
	},
	
	getProcsFast(callback) {
		// get process information fast
		var self = this;
		var now = Tools.timeNow(true);
		
		if (this.platform.windows) {
			return si.processes( function(data) {
				data.list.forEach( function(proc) {
					// convert data to our native format
					try { 
						proc.started = Math.floor( (new Date(proc.started)).getTime() / 1000 );
						proc.age = now - proc.started;
					}
					catch (e) { proc.started = proc.age = 0; }
					
					// some commands are quoted
					proc.command = proc.command.replace(/^\"(.+?)\"/, '$1');
					
					// cleanup state
					proc.state = Tools.ucfirst( proc.state || 'unknown' );
					
					// memory readings are in kilobytes
					proc.memRss *= 1024;
					proc.memVsz *= 1024;
					
					// delete redundant props
					delete proc.path;
					delete proc.params;
				});
				callback(data);
			} );
		} // windows
		
		var info = { list: [] };
		var ps_args = [];
		var ps_opts = {
			env: Object.assign( {}, process.env ),
			maxBuffer: 1024 * 1024 * 100, 
			timeout: 30000 
		};
		const colMap = {
			ppid: 'parentPid',
			rss: 'memRss',
			vsz: 'memVsz',
			tt: 'tty',
			thcnt: 'threads',
			pri: 'priority',
			ni: 'nice',
			s: 'state',
			stat: 'state',
			elapsed: 'age',
			cls: 'class',
			gid: 'group',
			args: 'command'
		};
		const stateMap = {
			I: 'Idle',
			S: 'Sleeping',
			D: 'Sleeping',
			U: 'Sleeping',
			R: 'Running',
			Z: 'Zombie',
			T: 'Stopped',
			t: 'Stopped',
			W: 'Paged',
			X: 'Dead'
		};
		const classMap = {
			TS: 'Other',
			FF: 'FIFO',
			RR: 'RR',
			B: 'Batch',
			ISO: 'ISO',
			IDL: 'Idle',
			DLN: 'Deadline'
		};
		const filterMap = {
			pid: parseInt,
			parentPid: parseInt,
			priority: parseInt,
			nice: parseInt,
			threads: parseInt,
			time: parseInt,
			
			// cpu: parseFloat,
			mem: parseFloat,
			
			cpu: function(value) {
				// divide by CPU count for real value
				return parseFloat(value) / self.numCPUs;
			},
			
			age: function(value) {
				if (value.match(/^\d+$/)) return parseInt(value);
				if (value.match(/^(\d+)\-(\d+)\:(\d+)\:(\d+)$/)) {
					// DD-HH:MI:SS
					var [ dd, hh, mi, ss ] = [ RegExp.$1, RegExp.$2, RegExp.$3, RegExp.$4 ];
					return ( (parseInt(dd) * 86400) + (parseInt(hh) * 3600) + (parseInt(mi) * 60) + parseInt(ss) );
				}
				if (value.match(/^(\d+)\:(\d+)\:(\d+)$/)) {
					// HH:MI:SS
					var [ hh, mi, ss ] = [ RegExp.$1, RegExp.$2, RegExp.$3 ];
					return ( (parseInt(hh) * 3600) + (parseInt(mi) * 60) + parseInt(ss) );
				}
				if (value.match(/^(\d+)\:(\d+)$/)) {
					// MI:SS
					var [ mi, ss ] = [ RegExp.$1, RegExp.$2 ];
					return ( (parseInt(mi) * 60) + parseInt(ss) );
				}
				return 0;
			},
			memRss: function(value) {
				return parseInt(value) * 1024;
			},
			memVsz: function(value) {
				return parseInt(value) * 1024;
			},
			state: function(value) {
				return stateMap[value.substring(0, 1)] || 'Unknown';
			},
			class: function(value) {
				return classMap[value] || 'Unknown';
			},
			group: function(value) {
				if (value.match(/^\d+$/)) {
					var group = Tools.getgrnam( value, true ); // cached in ram
					if (group && group.name) return group.name;
				}
				return value;
			}
		};
		
		if (this.platform.linux) {
			// PID    PPID USER     %CPU   RSS ELAPSED S PRI  NI    VSZ TT       %MEM CLS GROUP    THCNT     TIME COMMAND
			ps_args = ['-eo', 'pid,ppid,user,%cpu,rss,etimes,state,pri,nice,vsz,tty,%mem,class,group,thcount,times,args'];
			ps_opts.env.LC_ALL = 'C';
		}
		else if (this.platform.darwin) {
			// PID  PPID  %CPU %MEM PRI      VSZ    RSS NI     ELAPSED STAT TTY      USER               GID ARGS
			ps_args = ['-axro', 'pid,ppid,%cpu,%mem,pri,vsz,rss,nice,etime,state,tty,user,group,args'];
		}
		
		cp.execFile( this.psBin, ps_args, ps_opts, function(err, stdout, stderr) {
			if (err) return callback(info);
			
			var lines = stdout.trim().split(/\n/);
			var headers = lines.shift().trim().split(/\s+/).map( function(key) { return key.trim().toLowerCase().replace(/\W+/g, ''); } );
			
			lines.forEach( function(line) {
				var cols = line.trim().split(/\s+/);
				if (cols.length > headers.length) {
					var extras = cols.splice(headers.length);
					cols[ headers.length - 1 ] += ' ' + extras.join(' ');
				}
				var proc = {};
				
				headers.forEach( function(key, idx) {
					key = colMap[key] || key;
					proc[key] = filterMap[key] ? filterMap[key](cols[idx]) : cols[idx];
				} );
				
				proc.started = Math.max(0, now - (proc.age || 0));
				
				// state bookkeeping
				var state = proc.state.toLowerCase();
				info[ state ] = (info[ state ] || 0) + 1;
				info.all = (info.all || 0) + 1;
				
				// filter out ps itself
				if ((proc.parentPid == process.pid) && (proc.command.startsWith(self.psBin))) return;
				
				info.list.push(proc);
			} );
			
			callback(info);
		}); // cp.execFile
	},
	
	shutdown() {
		// all done
		if (this.timer) clearInterval(this.timer);
		delete this.timer;
	}
};

process.on('SIGTERM', app.abortJob.bind(app) );
process.on('SIGINT', app.abortJob.bind(app) );
process.on('SIGHUP', app.abortJob.bind(app) );

app.run();
