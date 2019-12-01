const child_process = require('child_process');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const os = require('os');
const request = require('request');
const progress = require('request-progress');
const colors = require('colors');
const AdmZip = require('adm-zip');
const gutil = require('gulp-util');
const _ = require('underscore');

class Util {

	constructor(core) {
		this.core = core;
	}

	getDirFiles(dir, testRegExp){
		var result = [];
		var files = fs.readdirSync(dir);
		_.each(files, function(file) {
			var filePath = path.join(dir, file);
			var stat = fs.statSync(filePath);

			if(!stat.isDirectory()){
				if(!testRegExp || testRegExp.test(filePath)){
					result[result.length] = {filePath:filePath, name:file, parentDirName:dir.split(path.sep).pop(), stat:stat};
				}
				return
			}

			result = result.concat(getDirFiles(filePath, testRegExp));
		})

		return result;
	}

	download(url, file, callback) {
		if(callback)
			return this.download_(url, file, callback);

		return new Promise((resolve, reject) => {
			this.download_(url, file, (error) => {
				if(error)
					return reject(error);
				resolve();
			})
		})
	}

	download_(url, file, callback) {

		// const { DEPS } = this.core;
		let target = file; //path.join(DEPS,file);

		if(this.core.flags.force && fs.existsSync(target))
			fs.unlinkSync(target);

		if(fs.existsSync(target)) {
			gutil.log(`File found at ${target.bold}`);
			gutil.log(`Skipping download...`);
			return callback();
		}

		let  MAX = Math.max(process.stdout.columns - 55, 5), MIN = 0, value = 0;
		console.log("Fetching: "+url);
		console.log("");

		progress(request({
			url,
			headers: {
			'User-Agent': 'Emanator'
			}			
		}), {
			throttle : 250,
			delay : 1000
		})
		.on('progress', function (state) {
			if(state.percent > 0.99)
				state.percent = 1;

			if(!state.percent)
				state.percent = 0;

			let value = Math.ceil(state.percent * MAX);
			//      console.log("value", value, state, state.percent)
			console.log('\x1B[1A\x1B[K|' +
				(new Array(value + 1)).join('█') + '' +
				(new Array(MAX - value + 1)).join('-') + '|  ' + (state.percent*100).toFixed(1) + '%  '
				+ state.size.transferred.toFileSize().split(' ').shift()+'/'
				+ state.size.total.toFileSize()+'  '
				+ (state.speed || 0).toFileSize()+'/s'
			);
		})
		.on('error', function (err) {
			console.log("error");
			err && console.log(err.toString());
			callback(err);
		})
		.pipe(fs.createWriteStream(target))
		.on('finish', function(err) {
			err && console.log(err.toString());
			callback();
		});
	}

	spawn(...args) {
		return new Promise((resolve, reject) => {
			if(this.core.flags.verbose && _.isArray(args[1]))
				console.log("running:".bold,args[0],args[1]);

			let options = args[args.length-1] || { };
			let proc = child_process.spawn(...args);
			let done = false;

			proc.on('close', (code) => {
				if(!done) {
					resolve(code);
					done = true;
				}

				if(options.resetTTY) {
					process.nextTick(()=>{
						// TODO - 2019.11.27
						// a really nasty hack to battle some type of a TTY reset in Node
						// that occurs on Windows after certain applications, such as Git
						// stdout seems to loose it's ANSI-related TTY/terminal properties
						// resulting in loss of color and ANSI escape codes not being
						// recognized.  Running another child with 'inherit' seems to reset
						// the condition.
						child_process.execFileSync('cmd.exe',['/Q','/C','echo.'], {stdio:'inherit'});
					});
				}
			})

			proc.on('error', (err) => {
				if(!done) {
					done = true;
					reject(err);
				}
			})
		})
	}


	unzip(file, folder) {
		return new Promise((resolve,reject) => {
			this.unzip_(file, folder, (err) => {
				return err ? reject(err) : resolve();
			})
		})
	}

	unzip_(file, folder, callback) {
		//const { DEPS } = this.core;

		if(this.core.flags.fast) {
			console.log(`FAST MODE: Skipping unzip for ${file}...`);
			return callback();
		}
		gutil.log(`Unzipping ${file.bold}...`)
		try {
			if(file.match(/\.zip$/ig)) {
				let archive = new AdmZip(file);
//				let archive = new AdmZip(path.join(folder,file));
				archive.extractAllTo(folder, true);
				gutil.log(`Unzipping ${file.bold} success`)
				
				return callback();
			}
			else if(file.match(/\.tar\.gz$/ig)) {
				let folder = path.dirname(file);
				console.log('tar','-xvf',file,folder);
				this.spawn('tar',['-xvf',file],{ cwd : folder },(err)=> {
					// if(err)
					// 	throw err;

					return callback(err);
				})
			}
		} catch(ex) {
			console.log(("\nError: "+ex).red.bold);
			ex.stack && console.log(ex.stack);
			console.log((`\nIt looks like ${file} is corrupt...\nPlease use "--force" to re-download...\n`).red.bold);
			process.exit(1);
		}
	}


	getConfig(name, defaults = null) {
	    function merge(dst, src) {
	        _.each(src, (v, k) => {
	            if(_.isArray(v)) { dst[k] = [ ]; merge(dst[k], v); }
	            else if(_.isObject(v)) { if(!dst[k] || _.isString(dst[k]) || !_.isObject(dst[k])) dst[k] = { };  merge(dst[k], v); }
	            else { if(_.isArray(src)) dst.push(v); else dst[k] = v; }
	        })
	    }

	    let filename = name+'.conf';
	    let host_filename = name+'.'+os.hostname()+'.conf';
	    let local_filename = name+'.local.conf';

	    let data = [ ];

	    fs.existsSync(filename) && data.push(fs.readFileSync(filename) || null);
	    fs.existsSync(host_filename) && data.push(fs.readFileSync(host_filename) || null);
	    fs.existsSync(local_filename) && data.push(fs.readFileSync(local_filename) || null);

	    if(!data[0] && !data[1]) {
	        console.error("Unable to read config file: ".bold+(filename+'').red.bold);
	        return defaults;
	    }

	    let o = defaults || { }
	    _.each(data, (conf) => {
	        if(!conf || !conf.toString('utf-8').length)
	            return;
	        let layer = eval('('+conf.toString('utf-8')+')');
	        merge(o, layer);
	    })

	    return o;
	}

	asyncMap(_list, fn, callback){
	    if(!_list || !_.isArray(_list))
	        return callback(new Error("asyncMap() supplied argument is not array"));
	    var list = _list.slice();
	    var result = [ ];
	    
	    var digest = ()=>{
	        var item = list.shift();
	        if(!item)
	            return callback(null, result);
	        fn(item, (err, data)=>{
	            if(err)
	                return callback(err);
	            data && result.push(data);
	            dpc(digest);
	        })
	    }

	    digest();
	}

	fileHash(filename, algorithm = 'sha1') {
		return new Promise((resolve, reject) => {
			// Algorithm depends on availability of OpenSSL on platform
			// Another algorithms: 'sha1', 'md5', 'sha256', 'sha512' ...
			let shasum = crypto.createHash(algorithm);
			try {
				let s = fs.ReadStream(filename)
				s.on('data', (data) => {
					shasum.update(data)
				})
				s.on('end', () => {
					resolve(shasum.digest('hex'));
				})
			} catch (error) {
				return reject(error);
			}
		});
	}

	copy(...args) {
		return fse.copy(...args);
	}

	move(...args) {
		return fse.move(...args);
	}

	remove(...args) {
		return fse.remove(...args);
	}

	mkdirp(...args) {
		return fse.mkdirp(...args);
	}

	emptyDir(...args) {
		return fse.emptyDir(...args);
	}

	ensureDir(...args) {
		return fse.ensureDir(...args);
	}

}

if(!Number.prototype.toFileSize) {
	Object.defineProperty(Number.prototype, 'toFileSize', {
		value: function(a, asNumber) {
			var b,c,d;
			var r = (
				a=a?[1e3,'k','B']:[1024,'K','iB'],
				b=Math,
				c=b.log,
				d=c(this)/c(a[0])|0,this/b.pow(a[0],d)
			).toFixed(2)

			if(!asNumber) {
				r += ' '+(d?(a[1]+'MGTPEZY')[--d]+a[2]:'Bytes');
			}
			return r;
		},
		writable:false,
		enumerable:false
	});
}

module.exports = Util;