import { THREE, onInstallHandlers } from '../install.js';
import EventDispatcher from './EventDispatcher.js';
import {
	testSegmentTriangle,
	isIntersectionSphereTriangle,
} from '../math/collision.js';

const FALL_VELOCITY = - 20;
const JUMP_DURATION = 1000;
const PI_HALF = Math.PI * 0.5;
const PI_ONE_HALF = Math.PI * 1.5;

let direction2D;
let wallNormal2D;
let groundingHead;
let groundingTo;
let point1;
let point2;
let direction;
let translateScoped;
let translate;

onInstallHandlers.push( () => {

	direction2D = new THREE.Vector2();
	wallNormal2D = new THREE.Vector2();
	groundingHead = new THREE.Vector3();
	groundingTo = new THREE.Vector3();
	point1 = new THREE.Vector3();
	point2 = new THREE.Vector3();
	direction = new THREE.Vector3();
	translateScoped = new THREE.Vector3();
	translate = new THREE.Vector3();

} );

export class CharacterController extends EventDispatcher {

	constructor( object3d, radius ) {

		super();

		this.isCharacterController = true;
		this.object = object3d;
		this.center = this.object.position.clone();
		this.radius = radius;
		this.groundPadding = .5;
		this.maxSlopeGradient = Math.cos( 50 * THREE.Math.DEG2RAD );
		this.isGrounded = false;
		this.isOnSlope  = false;
		this.isIdling   = false;
		this.isRunning  = false;
		this.isJumping  = false;
		this.direction  = 0; // 0 to 2PI(=360deg) in rad
		this.movementSpeed = 10; // Meters Per Second
		this.velocity = new THREE.Vector3( 0, - 10, 0 );
		this.currentJumpPower = 0;
		this.jumpStartTime = 0;
		this.groundHeight = 0;
		this.groundNormal = new THREE.Vector3();
		this.collisionCandidate;
		this.contactInfo = [];

		let isFirstUpdate = true;
		let wasGrounded;
		let wasOnSlope;
		// let wasIdling;
		let wasRunning;
		let wasJumping;

		this._events = () => {

			// 初回のみ、過去状態を作るだけで終わり
			if ( isFirstUpdate ) {

				isFirstUpdate = false;
				wasGrounded = this.isGrounded;
				wasOnSlope  = this.isOnSlope;
				// wasIdling   = this.isIdling;
				wasRunning  = this.isRunning;
				wasJumping  = this.isJumping;
				return;

			}

			if ( ! wasRunning && ! this.isRunning && this.isGrounded && ! this.isIdling ) {

				this.isIdling = true;
				this.dispatchEvent( { type: 'startIdling' } );

			} else if (
				( ! wasRunning && this.isRunning && ! this.isJumping && this.isGrounded ) ||
				( ! wasGrounded && this.isGrounded && this.isRunning ) ||
				( wasOnSlope && ! this.isOnSlope && this.isRunning && this.isGrounded )
			) {

				this.isIdling = false;
				this.dispatchEvent( { type: 'startWalking' } );

			} else if ( ! wasJumping && this.isJumping ) {

				this.isIdling = false;
				this.dispatchEvent( { type: 'startJumping' } );

			} else if ( ! wasOnSlope && this.isOnSlope ) {

				this.dispatchEvent( { type: 'startSliding' } );

			} else if ( wasGrounded && ! this.isGrounded && ! this.isJumping ) {

				this.dispatchEvent( { type: 'startFalling' } );

			}

			if ( ! wasGrounded && this.isGrounded ) {
				// startIdlingが先に発生している問題がある
				// TODO このイベントのn秒後にstartIdlingを始めるように変更する
				// this.dispatchEvent( { type: 'endJumping' } );

			}

			wasGrounded = this.isGrounded;
			wasOnSlope  = this.isOnSlope;
			// wasIdling   = this.isIdling;
			wasRunning  = this.isRunning;
			wasJumping  = this.isJumping;

		};

	}

	update( dt ) {

		// 状態をリセットしておく
		this.isGrounded = false;
		this.isOnSlope  = false;
		this.groundHeight = - Infinity;
		this.groundNormal.set( 0, 1, 0 );

		this._updateGrounding();
		this._updateJumping();
		this._updatePosition( dt );
		this._collisionDetection();
		this._solvePosition();
		this._updateVelocity();
		this._events();

	}

	_updateVelocity() {

		const frontDirection = - Math.cos( this.direction );
		const rightDirection = - Math.sin( this.direction );

		let isHittingCeiling = false;

		this.velocity.set(
			rightDirection * this.movementSpeed * this.isRunning,
			FALL_VELOCITY,
			frontDirection * this.movementSpeed * this.isRunning
		);

		// 急勾配や自由落下など、自動で付与される速度の処理
		if ( this.contactInfo.length === 0 && ! this.isJumping ) {

			// 何とも衝突していないので、自由落下
			return;

		} else if ( this.isGrounded && ! this.isOnSlope && ! this.isJumping ) {

			// 通常の地面上にいる場合、ただしジャンプ開始時は除く
			this.velocity.y = 0;

		} else if ( this.isOnSlope ) {

			// TODO 0.2 はマジックナンバーなので、幾何学的な求め方を考える
			const slidingDownVelocity = FALL_VELOCITY;
			const horizontalSpeed = - slidingDownVelocity / ( 1 - this.groundNormal.y ) * 0.2;

			this.velocity.x = this.groundNormal.x * horizontalSpeed;
			this.velocity.y = FALL_VELOCITY;
			this.velocity.z = this.groundNormal.z * horizontalSpeed;

		} else if ( ! this.isGrounded && ! this.isOnSlope && this.isJumping ) {

			// ジャンプの処理
			this.velocity.y = this.currentJumpPower * - FALL_VELOCITY;

		}


		// 壁に向かった場合、壁方向の速度を0にする処理
		// vs walls and sliding on the wall
		direction2D.set( rightDirection, frontDirection );
		// const frontAngle = Math.atan2( direction2D.y, direction2D.x );
		const negativeFrontAngle = Math.atan2( - direction2D.y, - direction2D.x );

		for ( let i = 0, l = this.contactInfo.length; i < l; i ++ ) {

			const normal = this.contactInfo[ i ].face.normal;
			// var distance = this.contactInfo[ i ].distance;

			if ( this.maxSlopeGradient < normal.y || this.isOnSlope ) {

			  // フェイスは地面なので、壁としての衝突の可能性はない。
			  // 速度の減衰はしないでいい
				continue;

			}

			if ( ! isHittingCeiling && normal.y < 0 ) {

				isHittingCeiling = true;

			}

			wallNormal2D.set( normal.x, normal.z ).normalize();
			const wallAngle = Math.atan2( wallNormal2D.y, wallNormal2D.x );

			if (
			  Math.abs( negativeFrontAngle - wallAngle ) >= PI_HALF &&  //  90deg
			  Math.abs( negativeFrontAngle - wallAngle ) <= PI_ONE_HALF // 270deg
			) {

			  // フェイスは進行方向とは逆方向、要は背中側の壁なので
			  // 速度の減衰はしないでいい
				continue;

			}

			// 上記までの条件に一致しなければ、フェイスは壁
			// 壁の法線を求めて、その逆方向に向いている速度ベクトルを0にする
			wallNormal2D.set(
			  direction2D.dot( wallNormal2D ) * wallNormal2D.x,
			  direction2D.dot( wallNormal2D ) * wallNormal2D.y
			);
			direction2D.sub( wallNormal2D );

			this.velocity.x = direction2D.x * this.movementSpeed * this.isRunning;
			this.velocity.z = direction2D.y * this.movementSpeed * this.isRunning;

		}

		// ジャンプ中に天井にぶつかったら、ジャンプを中断する
		if ( isHittingCeiling ) {

			this.velocity.y = Math.min( 0, this.velocity.y );
			this.isJumping = false;

		}

	}

	_updateGrounding() {

		// "頭上からほぼ無限に下方向までの線 (segment)" vs "フェイス (triangle)" の
		// 交差判定を行う
		// もし、フェイスとの交差点が「頭上」から「下groundPadding」までの間だったら
		// 地面上 (isGrounded) にいることとみなす
		//
		//   ___
		//  / | \
		// |  |  | player sphere
		//  \_|_/
		//    |
		//---[+]---- ground
		//    |
		//    |
		//    | segment (player's head to almost -infinity)

		let groundContactInfo;
		let groundContactInfoTmp;
		const faces = this.collisionCandidate;

		groundingHead.set(
			this.center.x,
			this.center.y + this.radius,
			this.center.z
		);

		groundingTo.set(
			this.center.x,
			this.center.y - 1e10,
			this.center.z
		);

		for ( let i = 0, l = faces.length; i < l; i ++ ) {

			groundContactInfoTmp = testSegmentTriangle(
				groundingHead,
				groundingTo,
				faces[ i ].a,
				faces[ i ].b,
				faces[ i ].c
			);

			if ( groundContactInfoTmp && ! groundContactInfo ) {

				groundContactInfo = groundContactInfoTmp;
				groundContactInfo.face = faces[ i ];

			} else if (
				groundContactInfoTmp &&
				groundContactInfoTmp.contactPoint.y > groundContactInfo.contactPoint.y
			) {

				groundContactInfo = groundContactInfoTmp;
				groundContactInfo.face = faces[ i ];

			}

		}

		if ( ! groundContactInfo ) {

			return;

		}

		this.groundHeight = groundContactInfo.contactPoint.y;
		this.groundNormal.copy( groundContactInfo.face.normal );

		const top    = groundingHead.y;
		const bottom = this.center.y - this.radius - this.groundPadding;

		// ジャンプ中、かつ上方向に移動中だったら、強制接地しない
		if ( this.isJumping && 0 < this.currentJumpPower ) {

			this.isOnSlope  = false;
			this.isGrounded = false;
			return;

		}

		this.isGrounded = ( bottom <= this.groundHeight && this.groundHeight <= top );
		this.isOnSlope  = ( this.groundNormal.y <= this.maxSlopeGradient );

		if ( this.isGrounded ) {

			this.isJumping = false;

		}

	}

	_updatePosition( dt ) {

		// 壁などを無視してひとまず(速度 * 時間)だけ
		// centerの座標を進める
		// 壁との衝突判定はこのこの後のステップで行うのでここではやらない
		// もしisGrounded状態なら、強制的にyの値を地面に合わせる
		const groundedY = this.groundHeight + this.radius;
		const x = this.center.x + this.velocity.x * dt;
		const y = this.center.y + this.velocity.y * dt;
		const z = this.center.z + this.velocity.z * dt;

		this.center.set(
			x,
			( this.isGrounded ? groundedY : y ),
			z
		);

	}

	_collisionDetection() {

		// 交差していそうなフェイス (collisionCandidate) のリストから、
		// 実際に交差している壁フェイスを抜き出して
		// this.contactInfoに追加する

		const faces = this.collisionCandidate;
		this.contactInfo.length = 0;

		for ( let i = 0, l = faces.length; i < l; i ++ ) {

			const contactInfo = isIntersectionSphereTriangle(
				this,
				faces[ i ].a,
				faces[ i ].b,
				faces[ i ].c,
				faces[ i ].normal
			);

			if ( ! contactInfo ) continue;

			contactInfo.face = faces[ i ];
			this.contactInfo.push( contactInfo );

		}

	}

	_solvePosition() {

		// updatePosition() で center を動かした後
		// 壁と衝突し食い込んでいる場合、
		// ここで壁の外への押し出しをする

		let face;
		let normal;
		// let distance;

		if ( this.contactInfo.length === 0 ) {

			// 何とも衝突していない
			// centerの値をそのままつかって終了
			this.object.position.copy( this.center );
			return;

		}

		//
		// vs walls and sliding on the wall
		translate.set( 0, 0, 0 );
		for ( let i = 0, l = this.contactInfo.length; i < l; i ++ ) {

			face = this.contactInfo[ i ].face;
			normal = this.contactInfo[ i ].face.normal;
			// distance = this.contactInfo[ i ].distance;

			// if ( 0 <= distance ) {

			//   // 交差点までの距離が 0 以上ならこのフェイスとは衝突していない
			//   // 無視する
			//   continue;

			// }

			if ( this.maxSlopeGradient < normal.y ) {

			  // this triangle is a ground or slope, not a wall or ceil
			  // フェイスは急勾配でない坂、つまり地面。
			  // 接地の処理は updatePosition() 内で解決しているので無視する
				continue;

			}

			// フェイスは急勾配な坂か否か
			const isSlopeFace = ( this.maxSlopeGradient <= face.normal.y && face.normal.y < 1 );

			// ジャンプ降下中に、急勾配な坂に衝突したらジャンプ終わり
			if ( this.isJumping && 0 >= this.currentJumpPower && isSlopeFace ) {

				this.isJumping = false;
				this.isGrounded = true;
			  // console.log( 'jump end' );

			}

			if ( this.isGrounded || this.isOnSlope ) {

			  // 地面の上にいる場合はy(縦)方向は同一のまま
			  // x, z (横) 方向だけを変更して押し出す
			  // http://gamedev.stackexchange.com/questions/80293/how-do-i-resolve-a-sphere-triangle-collision-in-a-given-direction
				point1.copy( normal ).multiplyScalar( - this.radius ).add( this.center );
				direction.set( normal.x, 0, normal.z ).normalize();
				const plainD = face.a.dot( normal );
				const t = ( plainD - ( normal.x * point1.x + normal.y * point1.y + normal.z * point1.z ) ) / ( normal.x * direction.x + normal.y * direction.y + normal.z * direction.z );
				point2.copy( direction ).multiplyScalar( t ).add( point1 );
				translateScoped.subVectors( point2, point1 );

				if ( Math.abs( translate.x ) > Math.abs( translateScoped.x ) ) {

					translate.x += translateScoped.x;

				}

				if ( Math.abs( translate.z ) > Math.abs( translateScoped.z ) ) {

					translate.z += translateScoped.z;

				}

				// break;
				continue;

			}

		}

		this.center.add( translate );
		this.object.position.copy( this.center );

	}

	setDirection() {}

	jump() {

		if ( this.isJumping || ! this.isGrounded || this.isOnSlope ) return;

		this.jumpStartTime = performance.now();
		this.currentJumpPower = 1;
		this.isJumping = true;

	}

	_updateJumping() {

		if ( ! this.isJumping ) return;

		const elapsed = performance.now() - this.jumpStartTime;
		const progress = elapsed / JUMP_DURATION;
		this.currentJumpPower = Math.cos( Math.min( progress, 1 ) * Math.PI );

	}

}
