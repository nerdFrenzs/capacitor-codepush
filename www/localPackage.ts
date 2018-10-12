/// <reference path="../typings/codePush.d.ts" />

"use strict";

declare var zip: any;

import { FilesystemDirectory, Plugins } from '@capacitor/core';
import InstallMode from "./installMode";
import Package = require("./package");
import NativeAppInfo = require("./nativeAppInfo");
import FileUtil = require("./fileUtil");
import CodePushUtil = require("./codePushUtil");
import Sdk = require("./sdk");

const NativeCodePush: NativeCodePushPlugin = (Plugins as any).CodePush;

/**
 * Defines a local package.
 *
 * !! THIS TYPE IS READ FROM NATIVE CODE AS WELL. ANY CHANGES TO THIS INTERFACE NEEDS TO BE UPDATED IN NATIVE CODE !!
 */
class LocalPackage extends Package implements ILocalPackage {
    public static RootDir: string = "codepush";

    public static DownloadDir: string = LocalPackage.RootDir + "/download";
    private static DownloadUnzipDir: string = LocalPackage.DownloadDir + "/unzipped";
    private static DeployDir: string = LocalPackage.RootDir + "/deploy";
    private static VersionsDir: string = LocalPackage.DeployDir + "/versions";

    public static PackageUpdateFileName: string = "update.zip";
    public static PackageInfoFile: string = "currentPackage.json";
    public static OldPackageInfoFile: string = "oldPackage.json";
    private static DiffManifestFile: string = "hotcodepush.json";

    private static DefaultInstallOptions: InstallOptions;

    /**
     * The local storage path where this package is located.
     */
    localPath: string;

    /**
     * Indicates if the current application run is the first one after the package was applied.
     */
    isFirstRun: boolean;

    /**
     * Applies this package to the application. The application will be reloaded with this package and on every application launch this package will be loaded.
     * On the first run after the update, the application will wait for a codePush.notifyApplicationReady() call. Once this call is made, the install operation is considered a success.
     * Otherwise, the install operation will be marked as failed, and the application is reverted to its previous version on the next run.
     *
     * @param installOptions Optional parameter used for customizing the installation behavior.
     */
    public async install(installOptions?: InstallOptions) : Promise<InstallMode> {
        return new Promise<InstallMode>((resolve, reject) => {
            try {
                CodePushUtil.logMessage("Installing update");

                if (!installOptions) {
                    installOptions = LocalPackage.getDefaultInstallOptions();
                } else {
                    CodePushUtil.copyUnassignedMembers(LocalPackage.getDefaultInstallOptions(), installOptions);
                }

                var installError: ErrorCallback = (error: Error): void => {
                    CodePushUtil.invokeErrorCallback(error, reject);
                    Sdk.reportStatusDeploy(this, AcquisitionStatus.DeploymentFailed, this.deploymentKey);
                };

                var newPackageLocation = LocalPackage.VersionsDir + "/" + this.packageHash;

                var newPackageUnzipped = function (unzipError: Error) {
                    if (unzipError) {
                        installError && installError(new Error("Could not unzip package" + CodePushUtil.getErrorMessage(unzipError)));
                    } else {
                        LocalPackage.handleDeployment(newPackageLocation, CodePushUtil.getNodeStyleCallbackFor<DeploymentResult>(donePackageFileCopy, installError));
                    }
                };

                var donePackageFileCopy = (deploymentResult: DeploymentResult) => {
                    this.verifyPackage(deploymentResult, installError, () => {
                        packageVerified(deploymentResult.deployDir);
                    });
                };

                var packageVerified = (deployDir: DirectoryEntry) => {
                    this.localPath = deployDir.fullPath;
                    this.finishInstall(deployDir, installOptions, resolve, installError);
                };

                FileUtil.getDataDirectory(LocalPackage.DownloadUnzipDir, false, (error: Error, directoryEntry: DirectoryEntry) => {
                    var unzipPackage = () => {
                        FileUtil.getDataDirectory(LocalPackage.DownloadUnzipDir, true, (innerError: Error, unzipDir: DirectoryEntry) => {
                            if (innerError) {
                                installError && installError(innerError);
                                return;
                            }

                            zip.unzip(this.localPath, unzipDir.toInternalURL(), newPackageUnzipped);

                        });
                    };

                    if (!error && !!directoryEntry) {
                        /* Unzip directory not clean */
                        directoryEntry.removeRecursively(() => {
                            unzipPackage();
                        }, (cleanupError: FileError) => {
                            installError && installError(FileUtil.fileErrorToError(cleanupError));
                        });
                    } else {
                        unzipPackage();
                    }
                });
            } catch (e) {
                installError && installError(new Error("An error occured while installing the package. " + CodePushUtil.getErrorMessage(e)));
            }
        })
    }

    private verifyPackage(deploymentResult: DeploymentResult, installError: ErrorCallback, successCallback: SuccessCallback<void>): void {
        
        var deployDir = deploymentResult.deployDir;

        var verificationFail: ErrorCallback = (error: Error) => {
            installError && installError(error);
        };

        var verify = (isSignatureVerificationEnabled: boolean, isSignatureAppearedInBundle: boolean, publicKey: string, signature: string) => {
            if (isSignatureVerificationEnabled) {
                if (isSignatureAppearedInBundle) {
                    this.verifyHash(deployDir, this.packageHash, verificationFail, () => {
                        this.verifySignature(deployDir, this.packageHash, publicKey, signature, verificationFail, successCallback);
                    });
                } else {
                    var errorMessage = 
                    "Error! Public key was provided but there is no JWT signature within app bundle to verify. " +
                    "Possible reasons, why that might happen: \n" +
                    "1. You've been released CodePush bundle update using version of CodePush CLI that is not support code signing.\n" +
                    "2. You've been released CodePush bundle update without providing --privateKeyPath option.";
                    installError && installError(new Error(errorMessage));
                }
            } else {
                if (isSignatureAppearedInBundle) {
                    CodePushUtil.logMessage(
                        "Warning! JWT signature exists in codepush update but code integrity check couldn't be performed because there is no public key configured. " +
                        "Please ensure that public key is properly configured within your application."
                    );
                        
                    //verifyHash
                    this.verifyHash(deployDir, this.packageHash, verificationFail, successCallback);
                } else {
                    if (deploymentResult.isDiffUpdate){
                        //verifyHash
                        this.verifyHash(deployDir, this.packageHash, verificationFail, successCallback);
                    } else {
                        successCallback();
                    }
                }          
            }
        }

        if (deploymentResult.isDiffUpdate){
            CodePushUtil.logMessage("Applying diff update");
        } else {
            CodePushUtil.logMessage("Applying full update");
        }

        var isSignatureVerificationEnabled: boolean, isSignatureAppearedInBundle: boolean;
        var publicKey: string;

        this.getPublicKey((error, publicKeyResult) => {
            if (error) {
                installError && installError(new Error("Error reading public key. " + error));
                return;
            }

            publicKey = publicKeyResult;
            isSignatureVerificationEnabled = (publicKey !== null);

            this.getSignatureFromUpdate(deploymentResult.deployDir, (error, signature) => {
                if (error) {
                    installError && installError(new Error("Error reading signature from update. " + error));
                    return;
                }

                isSignatureAppearedInBundle = (signature !== null);

                verify(isSignatureVerificationEnabled, isSignatureAppearedInBundle, publicKey, signature);
            });
        });
    }

    private getPublicKey(callback: Callback<string>) {
    
        var success = (publicKey: string) => {
            callback(null, publicKey);
        }

        var fail = (error: Error) => {
            callback(error, null);
        }

        NativeCodePush.getPublicKey().then(result => success(result.value || null), fail);
    }

    private getSignatureFromUpdate(deployDir: DirectoryEntry, callback: Callback<string>){

        const filePath = deployDir.fullPath + '/www/.codepushrelease';

        FileUtil.fileExists(FilesystemDirectory.Data, filePath, (error, result) => {
            if (!result) {
                // signature absents in the bundle
                callback(null, null);
                return;
            }

            FileUtil.readFile(FilesystemDirectory.Data, filePath, (error, signature) => {
                if (error) {
                    //error reading signature file from bundle
                    callback(error, null);
                    return;
                }
                
                callback(null, signature);
            });
        });
    }

    private verifyHash(deployDir: DirectoryEntry, newUpdateHash: string, errorCallback: ErrorCallback, successCallback: SuccessCallback<void>){
        var packageHashSuccess = (computedHash: string) => {
            if (computedHash !== newUpdateHash) {
                errorCallback(new Error("The update contents failed the data integrity check."));
                return;
            }

            CodePushUtil.logMessage("The update contents succeeded the data integrity check.");
            successCallback();
        }
        var packageHashFail = (error: Error) => {
            errorCallback(new Error("Unable to compute hash for package: " + error));
        }
        CodePushUtil.logMessage("Verifying hash for folder path: " + deployDir.fullPath);
        NativeCodePush.getPackageHash({path: deployDir.fullPath}).then(result => packageHashSuccess(result.value), packageHashFail);
    }

    private verifySignature(deployDir: DirectoryEntry, newUpdateHash: string, publicKey: string, signature: string, errorCallback: ErrorCallback, successCallback: SuccessCallback<void>){
        var decodeSignatureSuccess = (contentHash: string) => {
            if (contentHash !== newUpdateHash) {
                errorCallback(new Error("The update contents failed the code signing check."));
                return;
            }

            CodePushUtil.logMessage("The update contents succeeded the code signing check.");
            successCallback();
        }
        var decodeSignatureFail = (error: Error) => {
            errorCallback(new Error("Unable to verify signature for package: " + error));
        }
        CodePushUtil.logMessage("Verifying signature for folder path: " + deployDir.fullPath);
        NativeCodePush.decodeSignature({publicKey, signature}).then(result =>decodeSignatureSuccess(result.value), decodeSignatureFail);
    }    

    private finishInstall(deployDir: DirectoryEntry, installOptions: InstallOptions, installSuccess: SuccessCallback<InstallMode>, installError: ErrorCallback): void {
        async function backupPackageInformationFileIfNeeded(backupIfNeededDone: Callback<void>) {
            const pendingUpdate = await NativeAppInfo.isPendingUpdate();
            if (pendingUpdate) {
                // Don't back up the  currently installed update since it hasn't been "confirmed"
                backupIfNeededDone(null, null);
            } else {
                LocalPackage.backupPackageInformationFile(backupIfNeededDone);
            }
        }

        LocalPackage.getCurrentOrDefaultPackage().then((oldPackage: LocalPackage) => {
            backupPackageInformationFileIfNeeded((backupError: Error) => {
                /* continue on error, current package information is missing if this is the first update */
                this.writeNewPackageMetadata(deployDir).then(() => {
                    var invokeSuccessAndInstall = () => {
                        CodePushUtil.logMessage("Install succeeded.");
                        var installModeToUse: InstallMode = this.isMandatory ? installOptions.mandatoryInstallMode : installOptions.installMode;
                        if (installModeToUse === InstallMode.IMMEDIATE) {
                            /* invoke success before navigating */
                            installSuccess && installSuccess(installModeToUse);
                            /* no need for callbacks, the javascript context will reload */
                            NativeCodePush.install({
                                startLocation: deployDir.fullPath,
                                installMode: installModeToUse,
                                minimumBackgroundDuration: installOptions.minimumBackgroundDuration
                            })
                        } else {
                            NativeCodePush.install({
                                startLocation: deployDir.fullPath,
                                installMode: installModeToUse,
                                minimumBackgroundDuration: installOptions.minimumBackgroundDuration
                            }).then(() => { installSuccess && installSuccess(installModeToUse); }, () => { installError && installError(); });
                        }
                    };

                    var preInstallSuccess = () => {
                        /* package will be cleaned up after success, on the native side */
                        invokeSuccessAndInstall();
                    };

                    var preInstallFailure = (preInstallError?: any) => {
                        CodePushUtil.logError("Preinstall failure.", preInstallError);
                        var error = new Error("An error has occured while installing the package. " + CodePushUtil.getErrorMessage(preInstallError));
                        installError && installError(error);
                    };

                    NativeCodePush.preInstall({startLocation: deployDir.fullPath}).then(preInstallSuccess, preInstallFailure);
                }, (writeMetadataError: Error) => {
                    installError && installError(writeMetadataError);
                });
            });
        }, installError);
    }

    private static handleDeployment(newPackageLocation: string, deployCallback: Callback<DeploymentResult>): void {
        FileUtil.getDataDirectory(newPackageLocation, true, (deployDirError: Error, deployDir: DirectoryEntry) => {
            // check for diff manifest
            FileUtil.getDataFile(LocalPackage.DownloadUnzipDir, LocalPackage.DiffManifestFile, false, (manifestError: Error, diffManifest: FileEntry) => {
                if (!manifestError && !!diffManifest) {
                    LocalPackage.handleDiffDeployment(newPackageLocation, diffManifest, deployCallback);
                } else {
                    LocalPackage.handleCleanDeployment(newPackageLocation, (error: Error) => {
                        deployCallback(error, {deployDir, isDiffUpdate: false});
                    });
                }
            });
        });
    }

    private async writeNewPackageMetadata(deployDir: DirectoryEntry): Promise<void> {
        const timestamp = await NativeAppInfo.getApplicationBuildTime().catch(buildTimeError => {
            CodePushUtil.logError("Could not get application build time. " + buildTimeError);
        });
        const appVersion = await NativeAppInfo.getApplicationVersion().catch(appVersionError => {
            CodePushUtil.logError("Could not get application version." + appVersionError);
        });

        const currentPackageMetadata: IPackageInfoMetadata = {
            nativeBuildTime: timestamp as string,
            localPath: this.localPath,
            appVersion: appVersion as string,
            deploymentKey: this.deploymentKey,
            description: this.description,
            isMandatory: this.isMandatory,
            packageSize: this.packageSize,
            label: this.label,
            packageHash: this.packageHash,
            isFirstRun: false,
            failedInstall: false,
            install: undefined
        };

        return new Promise<void>((resolve, reject) => {
            LocalPackage.writeCurrentPackageInformation(currentPackageMetadata, error => error ? reject(error) : resolve());
        })
    }

    private static handleCleanDeployment(newPackageLocation: string, cleanDeployCallback: Callback<DeploymentResult>): void {
        // no diff manifest
        FileUtil.getDataDirectory(newPackageLocation, true, (deployDirError: Error, deployDir: DirectoryEntry) => {
            FileUtil.getDataDirectory(LocalPackage.DownloadUnzipDir, false, (unzipDirErr: Error, unzipDir: DirectoryEntry) => {
                if (unzipDirErr || deployDirError) {
                    cleanDeployCallback(new Error("Could not copy new package."), null);
                } else {
                    FileUtil.copyDirectoryEntriesTo(unzipDir, deployDir, [/*no need to ignore copy anything*/], (copyError: Error) => {
                        if (copyError) {
                            cleanDeployCallback(copyError, null);
                        } else {
                            cleanDeployCallback(null, {deployDir, isDiffUpdate: false});
                        }
                    });
                }
            });
        });
    }

    private static copyCurrentPackage(newPackageLocation: string, ignoreList: string[], copyCallback: Callback<void>): void {
        var handleError = (e: Error) => {
            copyCallback && copyCallback(e, null);
        };

        var doCopy = (currentPackagePath?: string) => {
            var getCurrentPackageDirectory: (getCurrentPackageDirectoryCallback: Callback<DirectoryEntry>) => void;
            if (currentPackagePath) {
                getCurrentPackageDirectory = (getCurrentPackageDirectoryCallback: Callback<DirectoryEntry>) => {
                    FileUtil.getDataDirectory(currentPackagePath, false, getCurrentPackageDirectoryCallback);
                };
            } else {
                // The binary's version is the latest
                newPackageLocation = newPackageLocation + "/www";
                getCurrentPackageDirectory = (getCurrentPackageDirectoryCallback: Callback<DirectoryEntry>) => {
                    FileUtil.getApplicationDirectory("www", getCurrentPackageDirectoryCallback);
                };
            }

            FileUtil.getDataDirectory(newPackageLocation, true, (deployDirError: Error, deployDir: DirectoryEntry) => {
                if (deployDirError) {
                    handleError(new Error("Could not acquire the source/destination folders. "));
                } else {
                    var success = (currentPackageDirectory: DirectoryEntry) => {
                        FileUtil.copyDirectoryEntriesTo(currentPackageDirectory, deployDir, ignoreList, copyCallback);
                    };

                    var fail = (fileSystemError: FileError) => {
                        copyCallback && copyCallback(FileUtil.fileErrorToError(fileSystemError), null);
                    };

                    getCurrentPackageDirectory(CodePushUtil.getNodeStyleCallbackFor(success, fail));
                }
            });
        };

        var packageFailure = (error: Error) => {
            doCopy();
        };

        var packageSuccess = (currentPackage: LocalPackage) => {
            doCopy(currentPackage.localPath);
        };

        LocalPackage.getPackage(LocalPackage.PackageInfoFile, packageSuccess, packageFailure);
    }

    private static handleDiffDeployment(newPackageLocation: string, diffManifest: FileEntry, diffCallback: Callback<DeploymentResult>): void {
        var handleError = (e: Error) => {
            diffCallback(e, null);
        };

        /* copy old files except signature file */
        LocalPackage.copyCurrentPackage(newPackageLocation, [".codepushrelease"], (currentPackageError: Error) => {
            /* copy new files */
            LocalPackage.handleCleanDeployment(newPackageLocation, (cleanDeployError: Error) => {
                /* delete files mentioned in the manifest */
                FileUtil.readFileEntry(diffManifest, (error: Error, content: string) => {
                    if (error || currentPackageError || cleanDeployError) {
                        handleError(new Error("Cannot perform diff-update."));
                    } else {
                        var manifest: IDiffManifest = JSON.parse(content);
                        FileUtil.deleteEntriesFromDataDirectory(newPackageLocation, manifest.deletedFiles, (deleteError: Error) => {
                            FileUtil.getDataDirectory(newPackageLocation, true, (deployDirError: Error, deployDir: DirectoryEntry) => {
                                if (deleteError || deployDirError) {
                                    handleError(new Error("Cannot clean up deleted manifest files."));
                                } else {
                                    diffCallback(null, {deployDir, isDiffUpdate: true});
                                }
                            });
                        });
                    }
                });
            });
        });
    }

    /**
    * Writes the given local package information to the current package information file.
    * @param packageInfoMetadata The object to serialize.
    * @param callback In case of an error, this function will be called with the error as the fist parameter.
    */
    public static writeCurrentPackageInformation(packageInfoMetadata: IPackageInfoMetadata, callback: Callback<void>): void {
        var content = JSON.stringify(packageInfoMetadata);
        FileUtil.writeStringToDataFile(content, LocalPackage.RootDir + "/" + LocalPackage.PackageInfoFile, true, callback);
    }

	/**
     * Backs up the current package information to the old package information file.
     * This file is used for recovery in case of an update going wrong.
     * @param callback In case of an error, this function will be called with the error as the fist parameter.
     */
    public static backupPackageInformationFile(callback: Callback<void>): void {
        var reportFileError = (error: FileError) => {
            callback(FileUtil.fileErrorToError(error), null);
        };

        var copyFile = (fileToCopy: FileEntry) => {
            fileToCopy.getParent((parent: DirectoryEntry) => {
                fileToCopy.copyTo(parent, LocalPackage.OldPackageInfoFile, () => {
                    callback(null, null);
                }, reportFileError);
            }, reportFileError);
        };

        var gotFile = (error: Error, currentPackageFile: FileEntry) => {
            if (error) {
                callback(error, null);
            } else {
                FileUtil.getDataFile(LocalPackage.RootDir, LocalPackage.OldPackageInfoFile, false, (error: Error, oldPackageFile: FileEntry) => {
                    if (!error && !!oldPackageFile) {
                        /* file already exists */
                        oldPackageFile.remove(() => {
                            copyFile(currentPackageFile);
                        }, reportFileError);
                    } else {
                        copyFile(currentPackageFile);
                    }
                });
            }
        };

        FileUtil.getDataFile(LocalPackage.RootDir, LocalPackage.PackageInfoFile, false, gotFile);
    }

    /**
     * Get the previous package information.
     *
     * @param packageSuccess Callback invoked with the old package information.
     * @param packageError Optional callback invoked in case of an error.
     */
    public static getOldPackage(packageSuccess: SuccessCallback<LocalPackage>, packageError?: ErrorCallback): void {
        return LocalPackage.getPackage(LocalPackage.OldPackageInfoFile, packageSuccess, packageError);
    }

    /**
     * Reads package information from a given file.
     *
     * @param packageFile The package file name.
     * @param packageSuccess Callback invoked with the package information.
     * @param packageError Optional callback invoked in case of an error.
     */
    public static getPackage(packageFile: string, packageSuccess: SuccessCallback<LocalPackage>, packageError?: ErrorCallback): void {
        var handleError = (e: Error) => {
            packageError && packageError(new Error("Cannot read package information. " + CodePushUtil.getErrorMessage(e)));
        };

        try {
            FileUtil.readDataFile(LocalPackage.RootDir + "/" + packageFile, (error: Error, content: string) => {
                if (error) {
                    handleError(error);
                } else {
                    try {
                        var packageInfo: IPackageInfoMetadata = JSON.parse(content);
                        LocalPackage.getLocalPackageFromMetadata(packageInfo).then(packageSuccess, packageError);
                    } catch (e) {
                        handleError(e);
                    }
                }
            });
        } catch (e) {
            handleError(e);
        }
    }

    private static async getLocalPackageFromMetadata(metadata: IPackageInfoMetadata): Promise<LocalPackage> {
        if (!metadata) {
            throw new Error("Invalid package metadata.");
        }

        const installFailed = await NativeAppInfo.isFailedUpdate(metadata.packageHash)
        const isFirstRun = await NativeAppInfo.isFirstRun(metadata.packageHash)
        const localPackage = new LocalPackage();

        localPackage.appVersion = metadata.appVersion;
        localPackage.deploymentKey = metadata.deploymentKey;
        localPackage.description = metadata.description;
        localPackage.isMandatory = metadata.isMandatory;
        localPackage.failedInstall = installFailed;
        localPackage.isFirstRun = isFirstRun;
        localPackage.label = metadata.label;
        localPackage.localPath = metadata.localPath;
        localPackage.packageHash = metadata.packageHash;
        localPackage.packageSize = metadata.packageSize;
        return localPackage;
    }

    public static getCurrentOrDefaultPackage(): Promise<LocalPackage> {
        return LocalPackage.getPackageInfoOrDefault(LocalPackage.PackageInfoFile);
    }

    public static async getOldOrDefaultPackage(): Promise<LocalPackage> {
        return LocalPackage.getPackageInfoOrDefault(LocalPackage.OldPackageInfoFile);
    }

    public static async getPackageInfoOrDefault(packageFile: string): Promise<LocalPackage> {
        return new Promise<LocalPackage>((resolve, reject) => {
            const packageFailure = async () => {
                /**
                 * For the default package we need the app version,
                 * and ideally the hash of the binary contents.
                 */
                let appVersion;
                try {
                    appVersion = await NativeAppInfo.getApplicationVersion();
                } catch (appVersionError) {
                    CodePushUtil.logError("Could not get application version." + appVersionError);
                    reject(appVersionError);
                    return;
                }

                const defaultPackage: LocalPackage = new LocalPackage();
                defaultPackage.appVersion = appVersion;
                try {
                    defaultPackage.packageHash = await NativeAppInfo.getBinaryHash()
                } catch (binaryHashError) {
                    CodePushUtil.logError("Could not get binary hash." + binaryHashError);
                }

                resolve(defaultPackage);
            };

            LocalPackage.getPackage(packageFile, resolve as any, packageFailure);
        })
    }

    public static getPackageInfoOrNull(packageFile: string, packageSuccess: SuccessCallback<LocalPackage>, packageError?: ErrorCallback): void {
        LocalPackage.getPackage(packageFile, packageSuccess, packageSuccess.bind(null, null));
    }

    /**
     * Returns the default options for the CodePush install operation.
     * If the options are not defined yet, the static DefaultInstallOptions member will be instantiated.
     */
    private static getDefaultInstallOptions(): InstallOptions {
        if (!LocalPackage.DefaultInstallOptions) {
            LocalPackage.DefaultInstallOptions = {
                installMode: InstallMode.ON_NEXT_RESTART,
                minimumBackgroundDuration: 0,
                mandatoryInstallMode: InstallMode.IMMEDIATE
            };
        }

        return LocalPackage.DefaultInstallOptions;
    }
}

export = LocalPackage;
